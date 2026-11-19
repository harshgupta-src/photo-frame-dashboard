package com.wesbos.homehq;

import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Home Assistant's state, live, over its WebSocket API (a minimal RFC 6455 client on a plain
 * Socket, so no library). On its own thread: auth with the token, subscribe to state_changed,
 * get_states once, then keep a cache of the watched domains and collect changes for the page.
 * Reconnects with a backoff; an HA ping every 30 s without a pong within 10 s counts as dead.
 */
final class HaLive {
  interface Listener {
    /** Stream thread. Authenticated, subscribed and snapshot loaded (true), or dropped (false). */
    void onLive(HaLive s, boolean live);
    /** Stream thread. Changes are waiting in takeChanges(). */
    void onChanges(HaLive s);
  }

  static final String TAG = "HomeHQ.live";
  static final int CONNECT_TIMEOUT_MS = 10000, READ_TICK_MS = 5000, MAX_MESSAGE = 8 << 20, MAX_HEADERS = 16 * 1024;
  static final long PING_MS = 30000, PONG_TIMEOUT_MS = 10000, BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60000;
  // Domains whose attributes change all the time (power, signal, ...): only a new state is sent.
  static final Set<String> STATE_ONLY = new HashSet<>(Arrays.asList("sensor", "binary_sensor"));
  // A playing media player updates its position about once a second; those alone aren't sent.
  static final Set<String> POSITION_KEYS = new HashSet<>(Arrays.asList("media_position", "media_position_updated_at"));
  static final int SUB_ID = 1, STATES_ID = 2;
  // HA writes events as {"type":"event","event":{...},"id":1}; older versions put the id first.
  // The only subscription is SUB_ID, so either prefix is one of its events.
  static final String EVENT_PREFIX = "{\"type\":\"event\",", SUB_PREFIX = "{\"id\":" + SUB_ID + ",\"type\":\"event\"";
  static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

  private final String baseUrl, token;
  final Set<String> domains;
  private final Listener listener;
  private final SecureRandom random = new SecureRandom();
  private final Object sleepLock = new Object(), writeLock = new Object();
  private volatile boolean running, live, wake;
  private Thread thread;
  private Socket socket;
  private OutputStream out;
  private InputStream in;
  private int nextId = 3;
  private volatile long nextPingAt;
  private long pingSentAt;
  private boolean pongDue;

  // Guarded by this: the watched states (entity_id → JSON) and what changed since the last take.
  private final Map<String, String> states = new LinkedHashMap<>();
  private final Map<String, String> changed = new LinkedHashMap<>();
  private final Set<String> removed = new LinkedHashSet<>();

  HaLive(String baseUrl, String token, Set<String> domains, Listener listener) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.domains = Collections.unmodifiableSet(new HashSet<>(domains));
    this.listener = listener;
  }

  void start() {
    running = true;
    thread = new Thread(this::run, "homehq-ha-live");
    thread.start();
  }

  void stop() {
    running = false;
    if (thread != null) thread.interrupt();
    synchronized (sleepLock) { sleepLock.notifyAll(); }
    // Closing a TLS socket can write, so not on the caller's (UI) thread.
    new Thread(this::closeSocket, "homehq-ha-live-stop").start();
  }

  boolean live() {
    return live;
  }

  boolean sameAs(String url, String tok, Set<String> d) {
    return baseUrl.equals(url) && token.equals(tok) && domains.equals(d);
  }

  /** The network came back: reconnect now instead of after the backoff, or check a live link soon. */
  void reconnectNow() {
    if (live) {
      nextPingAt = 0;
      return;
    }
    synchronized (sleepLock) {
      wake = true;
      sleepLock.notifyAll();
    }
  }

  /** {"full":true,"live":true,"states":[...]} from the cache; clears pending changes. Null when not live. */
  synchronized String takeFull() {
    if (!live) return null;
    changed.clear();
    removed.clear();
    StringBuilder b = new StringBuilder(64 + states.size() * 400).append("{\"full\":true,\"live\":true,\"states\":[");
    join(b, states.values());
    return b.append("]}").toString();
  }

  /** {"live":true,"states":[...],"removed":[...]} with the latest of each changed entity; null when none. */
  synchronized String takeChanges() {
    if (!live || (changed.isEmpty() && removed.isEmpty())) return null;
    StringBuilder b = new StringBuilder(64 + changed.size() * 400).append("{\"live\":true,\"states\":[");
    join(b, changed.values());
    b.append("],\"removed\":[");
    boolean first = true;
    for (String id : removed) {
      if (!first) b.append(',');
      first = false;
      b.append(JSONObject.quote(id));
    }
    changed.clear();
    removed.clear();
    return b.append("]}").toString();
  }

  private static void join(StringBuilder b, Iterable<String> items) {
    boolean first = true;
    for (String s : items) {
      if (!first) b.append(',');
      first = false;
      b.append(s);
    }
  }

  private void run() {
    long backoff = BACKOFF_MIN_MS;
    while (running) {
      boolean wasLive = false;
      try {
        connect();
        wasLive = session();
      } catch (IOException | JSONException e) {
        if (running) Log.w(TAG, "Home Assistant stream: " + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()));
      } catch (RuntimeException e) {
        if (running) Log.w(TAG, "Home Assistant stream failed", e);
      }
      wasLive |= live;
      closeSocket();
      if (live) {
        live = false;
        if (running) listener.onLive(this, false);
      }
      if (!running) break;
      if (wasLive) backoff = BACKOFF_MIN_MS;
      synchronized (sleepLock) {
        long until = System.currentTimeMillis() + backoff;
        while (running && !wake) {
          long left = until - System.currentTimeMillis();
          if (left <= 0) break;
          try {
            sleepLock.wait(left);
          } catch (InterruptedException e) {
            if (!running) break;
          }
        }
        if (wake) backoff = BACKOFF_MIN_MS / 2;
        wake = false;
      }
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private void connect() throws IOException {
    URI u = URI.create(baseUrl);
    boolean tls = "https".equalsIgnoreCase(u.getScheme());
    String host = u.getHost();
    if (host == null) throw new IOException("no host in the Home Assistant URL");
    int port = u.getPort() != -1 ? u.getPort() : tls ? 443 : 80;
    String path = (u.getRawPath() == null ? "" : u.getRawPath().replaceAll("/+$", "")) + "/api/websocket";
    Socket s = new Socket();
    synchronized (writeLock) { socket = s; }
    s.setTcpNoDelay(true);
    s.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
    s.setSoTimeout(CONNECT_TIMEOUT_MS);
    if (tls) {
      SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(s, host, port, true);
      ssl.startHandshake();
      // SSLSocket checks the chain but not the name.
      if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.getSession())) {
        ssl.close();
        throw new IOException("certificate doesn't match " + host);
      }
      s = ssl;
      synchronized (writeLock) { socket = s; }
    }
    byte[] nonce = new byte[16];
    random.nextBytes(nonce);
    String key = base64(nonce);
    String hostHeader = host + (u.getPort() != -1 ? ":" + port : "");
    String req = "GET " + path + " HTTP/1.1\r\nHost: " + hostHeader + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
    OutputStream o = s.getOutputStream();
    o.write(req.getBytes(StandardCharsets.ISO_8859_1));
    o.flush();
    InputStream i = new BufferedInputStream(s.getInputStream(), 16 * 1024);
    in = i;
    synchronized (writeLock) { out = o; }
    ByteArrayOutputStream h = new ByteArrayOutputStream(512);
    for (int last4 = 0; last4 != 0x0D0A0D0A; ) {
      int c = i.read();
      if (c < 0) throw new IOException("connection closed during handshake");
      if (h.size() >= MAX_HEADERS) throw new IOException("handshake reply too long");
      h.write(c);
      last4 = (last4 << 8) | c;
    }
    String headers = new String(h.toByteArray(), StandardCharsets.ISO_8859_1);
    String status = headers.substring(0, Math.max(0, headers.indexOf('\r')));
    if (!status.matches("HTTP/1\\.[01] 101 .*")) throw new IOException("handshake refused: " + status);
    String accept = null;
    for (String line : headers.split("\r\n")) {
      int colon = line.indexOf(':');
      if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("Sec-WebSocket-Accept")) accept = line.substring(colon + 1).trim();
    }
    if (!acceptFor(key).equals(accept)) throw new IOException("bad Sec-WebSocket-Accept");
    s.setSoTimeout(READ_TICK_MS);
  }

  /** Runs one connection to its end. Returns whether it went live. */
  private boolean session() throws IOException, JSONException {
    boolean snapshot = false;
    nextPingAt = System.currentTimeMillis() + PING_MS;
    pongDue = false;
    while (running) {
      String text = readMessage();
      if (text == null) continue;
      if (text.startsWith(EVENT_PREFIX) || text.startsWith(SUB_PREFIX)) {
        if (snapshot) onEvent(text);
        continue;
      }
      JSONObject m = new JSONObject(text);
      String type = m.optString("type");
      if ("auth_required".equals(type)) {
        JSONObject auth = new JSONObject().put("type", "auth").put("access_token", token);
        sendText(auth.toString());
      } else if ("auth_ok".equals(type)) {
        sendText("{\"id\":" + SUB_ID + ",\"type\":\"subscribe_events\",\"event_type\":\"state_changed\"}");
        sendText("{\"id\":" + STATES_ID + ",\"type\":\"get_states\"}");
      } else if ("auth_invalid".equals(type)) {
        throw new IOException("Home Assistant refused the token");
      } else if ("pong".equals(type)) {
        pongDue = false;
      } else if ("event".equals(type) && m.optInt("id") == SUB_ID) {
        if (snapshot) onEvent(m);
      } else if ("result".equals(type)) {
        int id = m.optInt("id");
        if (!m.optBoolean("success")) {
          if (id == SUB_ID || id == STATES_ID) throw new IOException("request " + id + " failed: " + m.optJSONObject("error"));
          continue;
        }
        if (id == STATES_ID) {
          loadSnapshot(m.optJSONArray("result"));
          snapshot = true;
          live = true;
          Log.i(TAG, "Live: " + states.size() + " entities in " + domains);
          listener.onLive(this, true);
        }
      }
    }
    return snapshot;
  }

  private void loadSnapshot(JSONArray all) throws JSONException {
    Map<String, String> fresh = new LinkedHashMap<>();
    if (all != null) {
      for (int i = 0; i < all.length(); i++) {
        JSONObject st = all.optJSONObject(i);
        if (st == null) continue;
        String id = st.optString("entity_id");
        if (!domains.contains(domainOf(id))) continue;
        st.remove("context");
        fresh.put(id, st.toString());
      }
    }
    synchronized (this) {
      states.clear();
      states.putAll(fresh);
      changed.clear();
      removed.clear();
    }
  }

  /** A state_changed event. Most events are for unwatched entities, so check before parsing. */
  private void onEvent(String text) throws JSONException {
    int i = text.indexOf("\"entity_id\":\"");
    if (i >= 0) {
      int start = i + 13, dot = text.indexOf('.', start);
      if (dot > start && dot - start < 64 && !domains.contains(text.substring(start, dot))) return;
    }
    onEvent(new JSONObject(text));
  }

  private void onEvent(JSONObject m) {
    JSONObject event = m.optJSONObject("event");
    JSONObject data = event != null ? event.optJSONObject("data") : null;
    if (data == null) return;
    String id = data.optString("entity_id");
    String domain = domainOf(id);
    if (!domains.contains(domain)) return;
    JSONObject now = data.optJSONObject("new_state"), before = data.optJSONObject("old_state");
    synchronized (this) {
      if (now == null) {
        if (states.remove(id) == null) return;
        changed.remove(id);
        removed.add(id);
      } else {
        now.remove("context");
        String json = now.toString();
        states.put(id, json);
        boolean quiet = before != null && (STATE_ONLY.contains(domain)
            ? before.optString("state").equals(now.optString("state"))
            : "media_player".equals(domain) && onlyPositionMoved(before, now));
        if (quiet) {
          // Not worth a push, but a change already waiting goes out with the latest copy.
          if (changed.containsKey(id)) changed.put(id, json);
          return;
        }
        removed.remove(id);
        changed.put(id, json);
      }
    }
    listener.onChanges(this);
  }

  /** Same state and attributes apart from the playback position (media_position*). */
  static boolean onlyPositionMoved(JSONObject before, JSONObject now) {
    if (!before.optString("state").equals(now.optString("state"))) return false;
    JSONObject a = before.optJSONObject("attributes"), b = now.optJSONObject("attributes");
    if (a == null || b == null || a.length() != b.length()) return false;
    boolean moved = false;
    for (Iterator<String> it = b.keys(); it.hasNext(); ) {
      String k = it.next();
      if (!a.has(k)) return false;
      boolean same = String.valueOf(a.opt(k)).equals(String.valueOf(b.opt(k)));
      if (POSITION_KEYS.contains(k)) moved |= !same;
      else if (!same) return false;
    }
    return moved;
  }

  static String domainOf(String entityId) {
    int dot = entityId == null ? -1 : entityId.indexOf('.');
    return dot > 0 ? entityId.substring(0, dot) : "";
  }

  // --- WebSocket frames (RFC 6455) ---

  /** The next complete text message, or null after a control frame or a binary message. */
  private String readMessage() throws IOException {
    ByteArrayOutputStream parts = null;
    int partsOp = 0;
    while (true) {
      int b0 = readByte(), b1 = readByte();
      boolean fin = (b0 & 0x80) != 0;
      int op = b0 & 0x0F;
      long len = b1 & 0x7F;
      if (len == 126) {
        len = (readByte() << 8) | readByte();
      } else if (len == 127) {
        len = 0;
        for (int k = 0; k < 8; k++) len = (len << 8) | readByte();
      }
      if (len < 0 || len > MAX_MESSAGE) throw new IOException("frame too large (" + len + " bytes)");
      byte[] mask = null;
      if ((b1 & 0x80) != 0) {
        mask = new byte[4];
        readFully(mask);
      }
      byte[] payload = new byte[(int) len];
      readFully(payload);
      if (mask != null) for (int k = 0; k < payload.length; k++) payload[k] ^= mask[k & 3];
      if (op >= 8) {
        if (op == 8) throw new IOException("closed by Home Assistant");
        if (op == 9) sendFrame(0xA, payload); // ping → pong
        if (parts == null) return null;
        continue; // control frames may arrive between fragments
      }
      if (op == 0) {
        if (parts == null) throw new IOException("continuation without a start");
      } else {
        if (parts != null) throw new IOException("new message inside a fragmented one");
        if (fin) return op == 1 ? new String(payload, StandardCharsets.UTF_8) : null;
        parts = new ByteArrayOutputStream(Math.max(1024, payload.length * 2));
        partsOp = op;
      }
      if (parts.size() + payload.length > MAX_MESSAGE) throw new IOException("message too large");
      parts.write(payload, 0, payload.length);
      if (fin) return partsOp == 1 ? new String(parts.toByteArray(), StandardCharsets.UTF_8) : null;
    }
  }

  private int readByte() throws IOException {
    while (true) {
      try {
        int c = in.read();
        if (c < 0) throw new IOException("connection closed");
        return c;
      } catch (SocketTimeoutException e) {
        keepAlive();
      }
    }
  }

  private void readFully(byte[] b) throws IOException {
    int off = 0;
    while (off < b.length) {
      try {
        int n = in.read(b, off, b.length - off);
        if (n < 0) throw new IOException("connection closed");
        off += n;
      } catch (SocketTimeoutException e) {
        keepAlive();
      }
    }
  }

  /** Called whenever a read waits READ_TICK_MS: send the HA ping when due, or give up on a missing pong. */
  private void keepAlive() throws IOException {
    if (!running) throw new IOException("stopped");
    long now = System.currentTimeMillis();
    if (pongDue) {
      if (now - pingSentAt > PONG_TIMEOUT_MS) throw new IOException("no pong from Home Assistant");
      return;
    }
    if (now < nextPingAt) return;
    sendText("{\"id\":" + (nextId++) + ",\"type\":\"ping\"}");
    pingSentAt = now;
    nextPingAt = now + PING_MS;
    pongDue = true;
  }

  private void sendText(String s) throws IOException {
    sendFrame(1, s.getBytes(StandardCharsets.UTF_8));
  }

  /** Client frames are always masked. */
  private void sendFrame(int op, byte[] payload) throws IOException {
    int len = payload.length;
    ByteArrayOutputStream f = new ByteArrayOutputStream(len + 14);
    f.write(0x80 | op);
    if (len < 126) {
      f.write(0x80 | len);
    } else if (len < 65536) {
      f.write(0x80 | 126);
      f.write(len >> 8);
      f.write(len & 0xFF);
    } else {
      f.write(0x80 | 127);
      for (int k = 7; k >= 0; k--) f.write(k >= 4 ? 0 : (len >>> (8 * k)) & 0xFF);
    }
    byte[] mask = new byte[4];
    random.nextBytes(mask);
    f.write(mask, 0, 4);
    for (int k = 0; k < len; k++) f.write(payload[k] ^ mask[k & 3]);
    synchronized (writeLock) {
      if (out == null) throw new IOException("not connected");
      out.write(f.toByteArray());
      out.flush();
    }
  }

  private void closeSocket() {
    synchronized (writeLock) {
      out = null;
      if (socket != null) {
        try {
          socket.close();
        } catch (IOException ignored) {
        }
      }
    }
  }

  static String acceptFor(String key) {
    try {
      MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
      return base64(sha1.digest((key + WS_GUID).getBytes(StandardCharsets.ISO_8859_1)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  // java.util.Base64 needs API 26; android.util.Base64 isn't on a desktop JVM (tests).
  static String base64(byte[] b) {
    final String abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    StringBuilder s = new StringBuilder((b.length + 2) / 3 * 4);
    for (int i = 0; i < b.length; i += 3) {
      int n = (b[i] & 0xFF) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xFF) << 8 : 0) | (i + 2 < b.length ? b[i + 2] & 0xFF : 0);
      s.append(abc.charAt(n >> 18 & 63)).append(abc.charAt(n >> 12 & 63));
      s.append(i + 1 < b.length ? abc.charAt(n >> 6 & 63) : '=').append(i + 2 < b.length ? abc.charAt(n & 63) : '=');
    }
    return s.toString();
  }
}
