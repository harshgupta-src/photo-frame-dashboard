package com.wesbos.homehq;

import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

/**
 * A minimal MQTT 3.1.1 client (plain TCP, QoS 0) so the kiosk needs no library. It keeps one
 * connection open on its own thread, reconnects with a backoff, and sets a retained last will so
 * the broker marks the frame offline when the connection drops.
 */
final class MqttClient {
  interface Listener {
    /** Runs on the client thread right after CONNACK; subscribe and publish from here. */
    void onConnected(MqttClient c) throws IOException;
    void onMessage(String topic, String payload);
  }

  static final String TAG = "HomeHQ.mqtt";
  static final int KEEPALIVE_S = 60, CONNECT_TIMEOUT_MS = 10000, MAX_PACKET = 64 * 1024;
  static final long BACKOFF_MIN_MS = 5000, BACKOFF_MAX_MS = 5 * 60 * 1000;

  private final String host, clientId, user, pass, willTopic, willPayload;
  private final int port;
  private final Listener listener;
  private volatile boolean running;
  private Thread thread;
  private Socket socket;
  private volatile OutputStream out;
  private int packetId;

  MqttClient(String host, int port, String clientId, String user, String pass,
      String willTopic, String willPayload, Listener listener) {
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this.user = user;
    this.pass = pass;
    this.willTopic = willTopic;
    this.willPayload = willPayload;
    this.listener = listener;
  }

  void start() {
    running = true;
    thread = new Thread(this::run, "homehq-mqtt");
    thread.start();
  }

  /** Publishes the will payload itself (a clean disconnect doesn't send the will), then closes. */
  void stop() {
    running = false;
    new Thread(() -> {
      try {
        publish(willTopic, willPayload, true);
        synchronized (this) { if (out != null) out.write(new byte[] {(byte) 0xE0, 0}); }
      } catch (IOException ignored) {
      }
      closeSocket();
    }, "homehq-mqtt-stop").start();
    if (thread != null) thread.interrupt();
  }

  boolean connected() {
    return out != null;
  }

  private void run() {
    long backoff = BACKOFF_MIN_MS;
    while (running) {
      try {
        connect();
        backoff = BACKOFF_MIN_MS;
        listener.onConnected(this);
        readLoop();
      } catch (IOException e) {
        if (running) Log.w(TAG, "MQTT " + host + ":" + port + ": " + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()));
      }
      closeSocket();
      if (!running) break;
      try {
        Thread.sleep(backoff);
      } catch (InterruptedException e) {
        break;
      }
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private void connect() throws IOException {
    Socket s = new Socket();
    s.setTcpNoDelay(true);
    s.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
    s.setSoTimeout(KEEPALIVE_S * 1000 / 2);
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    str(b, "MQTT");
    b.write(4); // protocol level 3.1.1
    int flags = 0x02 | 0x04 | 0x20; // clean session, will, retained will (QoS 0)
    if (user != null) flags |= 0x80;
    if (pass != null) flags |= 0x40;
    b.write(flags);
    b.write(KEEPALIVE_S >> 8);
    b.write(KEEPALIVE_S & 0xFF);
    str(b, clientId);
    str(b, willTopic);
    str(b, willPayload);
    if (user != null) str(b, user);
    if (pass != null) str(b, pass);
    synchronized (this) {
      socket = s;
      out = null;
      writePacket(s.getOutputStream(), 0x10, b.toByteArray());
    }
    DataInputStream in = new DataInputStream(s.getInputStream());
    int type = in.readUnsignedByte();
    byte[] body = readBody(in);
    if (type != 0x20 || body.length < 2) throw new IOException("unexpected reply to CONNECT");
    if (body[1] != 0) {
      // 4: bad user name or password, 5: not authorized. The password is never logged.
      throw new IOException("broker refused the connection (code " + body[1] + ")");
    }
    synchronized (this) { out = s.getOutputStream(); }
    Log.i(TAG, "Connected to " + host + ":" + port + " as " + clientId);
  }

  private void readLoop() throws IOException {
    DataInputStream in = new DataInputStream(socket.getInputStream());
    long lastHeard = System.currentTimeMillis();
    while (running) {
      int header;
      try {
        header = in.readUnsignedByte();
      } catch (SocketTimeoutException e) {
        if (System.currentTimeMillis() - lastHeard > KEEPALIVE_S * 1500L) throw new IOException("broker stopped answering");
        synchronized (this) { if (out != null) out.write(new byte[] {(byte) 0xC0, 0}); } // PINGREQ
        continue;
      }
      lastHeard = System.currentTimeMillis();
      byte[] body = readBody(in);
      if ((header & 0xF0) != 0x30) continue; // only PUBLISH needs handling (CONNACK/SUBACK/PINGRESP)
      int qos = (header >> 1) & 3;
      int topicLen = ((body[0] & 0xFF) << 8) | (body[1] & 0xFF);
      String topic = new String(body, 2, topicLen, StandardCharsets.UTF_8);
      int pos = 2 + topicLen;
      if (qos > 0) {
        int id = ((body[pos] & 0xFF) << 8) | (body[pos + 1] & 0xFF);
        pos += 2;
        if (qos == 1) synchronized (this) { if (out != null) out.write(new byte[] {0x40, 2, (byte) (id >> 8), (byte) id}); }
      }
      listener.onMessage(topic, new String(body, pos, body.length - pos, StandardCharsets.UTF_8));
    }
  }

  synchronized void subscribe(String... topics) throws IOException {
    if (out == null) throw new IOException("not connected");
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    packetId = packetId % 0xFFFF + 1;
    b.write(packetId >> 8);
    b.write(packetId & 0xFF);
    for (String t : topics) {
      str(b, t);
      b.write(0);
    }
    writePacket(out, 0x82, b.toByteArray());
  }

  /** QoS 0. Returns false (and drops the message) when not connected. */
  synchronized boolean publish(String topic, String payload, boolean retain) throws IOException {
    if (out == null) return false;
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    str(b, topic);
    b.write(payload.getBytes(StandardCharsets.UTF_8));
    writePacket(out, retain ? 0x31 : 0x30, b.toByteArray());
    return true;
  }

  private synchronized void closeSocket() {
    out = null;
    if (socket != null) {
      try {
        socket.close();
      } catch (IOException ignored) {
      }
    }
  }

  private static void str(ByteArrayOutputStream b, String s) {
    byte[] v = s.getBytes(StandardCharsets.UTF_8);
    b.write(v.length >> 8);
    b.write(v.length & 0xFF);
    b.write(v, 0, v.length);
  }

  private static void writePacket(OutputStream o, int header, byte[] body) throws IOException {
    ByteArrayOutputStream p = new ByteArrayOutputStream(body.length + 5);
    p.write(header);
    int len = body.length;
    do {
      int d = len % 128;
      len /= 128;
      p.write(len > 0 ? d | 0x80 : d);
    } while (len > 0);
    p.write(body, 0, body.length);
    o.write(p.toByteArray());
    o.flush();
  }

  private static byte[] readBody(DataInputStream in) throws IOException {
    int len = 0, mult = 1, d;
    do {
      d = in.readUnsignedByte();
      len += (d & 0x7F) * mult;
      mult *= 128;
      if (mult > 128 * 128 * 128 * 128) throw new IOException("bad packet length");
    } while ((d & 0x80) != 0);
    if (len > MAX_PACKET) throw new IOException("packet too large (" + len + " bytes)");
    byte[] body = new byte[len];
    in.readFully(body);
    return body;
  }
}
