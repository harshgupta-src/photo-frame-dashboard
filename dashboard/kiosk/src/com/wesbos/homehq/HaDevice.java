package com.wesbos.homehq;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The frame as a Home Assistant device over MQTT discovery: screen on/off, screen brightness and
 * auto brightness, ambient light (lux), "moved" from the accelerometer, "touched" from the
 * touchscreen, and a reload button. Commands arrive on homehq/<id>/<entity>/set, so the frame
 * opens no port of its own. See kiosk/README.md, "Home Assistant device (MQTT)".
 */
final class HaDevice implements MqttClient.Listener {
  /** Implemented by MainActivity; every call is on the main thread. */
  interface Host {
    boolean screenOn();
    void setScreen(boolean on);
    int brightness(); // percent, 1-100
    boolean autoBrightness();
    void setBrightness(int percent);
    void setAutoBrightness(boolean auto);
    void reloadDashboard();
  }

  static final String TAG = "HomeHQ.ha";
  static final String DISCOVERY_PREFIX = "homeassistant";
  static final long LUX_MIN_MS = 2000, LUX_HEARTBEAT_MS = 5 * 60 * 1000;
  static final long MOVED_HOLD_MS = 30 * 1000, TOUCHED_HOLD_MS = 60 * 1000;
  // Change in m/s² from the slow average that counts as the frame being moved or bumped. The
  // SC7A20 on a PF1007L at rest wobbles by about 0.2 per axis.
  static final float MOVE_THRESHOLD = 1.2f, MOVE_AVERAGE = 0.05f;

  private final Context context;
  private final Host host;
  private final String id, base, name;
  private final MqttClient client;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final SensorManager sensors;
  private final PowerManager.WakeLock cpuLock;
  private final WifiManager.WifiLock wifiLock;

  private float lux = Float.NaN, luxSent = Float.NaN;
  private long luxSentAt;
  private final float[] avg = new float[3];
  private boolean haveAvg, moved, touched;
  private long touchedAt;

  private final SensorEventListener light = new SensorEventListener() {
    @Override
    public void onSensorChanged(SensorEvent e) {
      lux = e.values[0];
      long now = SystemClock.elapsedRealtime();
      boolean changed = Float.isNaN(luxSent) || Math.abs(lux - luxSent) >= Math.max(2f, luxSent * 0.1f);
      if ((changed && now - luxSentAt >= LUX_MIN_MS) || now - luxSentAt >= LUX_HEARTBEAT_MS) publishLux();
    }

    @Override
    public void onAccuracyChanged(Sensor s, int accuracy) {}
  };

  private final SensorEventListener motion = new SensorEventListener() {
    @Override
    public void onSensorChanged(SensorEvent e) {
      if (!haveAvg) {
        System.arraycopy(e.values, 0, avg, 0, 3);
        haveAvg = true;
        return;
      }
      float d2 = 0;
      for (int i = 0; i < 3; i++) {
        float d = e.values[i] - avg[i];
        d2 += d * d;
        avg[i] += d * MOVE_AVERAGE;
      }
      if (d2 > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        main.removeCallbacks(movedOff);
        main.postDelayed(movedOff, MOVED_HOLD_MS);
        if (!moved) {
          moved = true;
          send("moved", "ON");
        }
      }
    }

    @Override
    public void onAccuracyChanged(Sensor s, int accuracy) {}
  };

  private final Runnable movedOff = () -> {
    moved = false;
    send("moved", "OFF");
  };

  private final Runnable touchedOff = () -> {
    touched = false;
    send("touched", "OFF");
  };

  HaDevice(Context context, Host host, String url, String user, String pass, String name) {
    this.context = context.getApplicationContext();
    this.host = host;
    this.name = name == null || name.trim().isEmpty() ? "Photo Frame" : name.trim();
    String androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
    this.id = "homehq_" + (androidId == null ? "frame" : androidId.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", ""));
    this.base = "homehq/" + id;
    Uri u = Uri.parse(url);
    int port = u.getPort() > 0 ? u.getPort() : 1883;
    client = new MqttClient(u.getHost(), port, id, user, pass, base + "/availability", "offline", this);
    sensors = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
    // The frame is always on power. Keep the CPU and Wi-Fi up while the screen is off, or the
    // connection drops and Home Assistant can't turn the screen back on.
    PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
    cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "homehq:mqtt");
    WifiManager wm = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    wifiLock = wm != null ? wm.createWifiLock(WifiManager.WIFI_MODE_FULL, "homehq:mqtt") : null;
  }

  /** mqtt://host[:port] or tcp://host[:port]. */
  static boolean validUrl(String url) {
    Uri u = Uri.parse(url);
    return ("mqtt".equalsIgnoreCase(u.getScheme()) || "tcp".equalsIgnoreCase(u.getScheme())) && u.getHost() != null;
  }

  void start() {
    cpuLock.acquire();
    if (wifiLock != null) wifiLock.acquire();
    if (sensors != null) {
      Sensor l = sensors.getDefaultSensor(Sensor.TYPE_LIGHT), a = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
      if (l != null) sensors.registerListener(light, l, SensorManager.SENSOR_DELAY_NORMAL);
      if (a != null) sensors.registerListener(motion, a, SensorManager.SENSOR_DELAY_NORMAL);
    }
    client.start();
    Log.i(TAG, "Home Assistant device " + id + " started");
  }

  void stop() {
    if (sensors != null) {
      sensors.unregisterListener(light);
      sensors.unregisterListener(motion);
    }
    main.removeCallbacksAndMessages(null);
    client.stop();
    io.shutdown();
    if (cpuLock.isHeld()) cpuLock.release();
    if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
  }

  /** The screen turned on or off, or its brightness changed. */
  void screenChanged() {
    send("screen", host.screenOn() ? "ON" : "OFF");
    send("brightness", String.valueOf(host.brightness()));
    send("auto_brightness", host.autoBrightness() ? "ON" : "OFF");
  }

  /** A touch on the dashboard. "Touched" stays on until a minute after the last touch. */
  void touched() {
    long now = SystemClock.elapsedRealtime();
    if (touched && now - touchedAt < 1000) return;
    touchedAt = now;
    main.removeCallbacks(touchedOff);
    main.postDelayed(touchedOff, TOUCHED_HOLD_MS);
    if (!touched) {
      touched = true;
      send("touched", "ON");
    }
  }

  private void publishLux() {
    if (Float.isNaN(lux)) return;
    luxSent = lux;
    luxSentAt = SystemClock.elapsedRealtime();
    send("illuminance", String.format(Locale.ROOT, "%.0f", lux));
  }

  /** Every state, retained, so Home Assistant has them after it restarts. */
  private void publishAll() {
    screenChanged();
    send("moved", moved ? "ON" : "OFF");
    send("touched", touched ? "ON" : "OFF");
    publishLux();
  }

  private void send(String entity, String payload) {
    final String topic = base + "/" + entity;
    try {
      io.execute(() -> {
        try {
          client.publish(topic, payload, true);
        } catch (IOException e) {
          Log.w(TAG, "Publish failed: " + e.getMessage());
        }
      });
    } catch (java.util.concurrent.RejectedExecutionException ignored) {
      // stopped
    }
  }

  @Override
  public void onConnected(MqttClient c) throws IOException {
    c.subscribe(base + "/+/set", DISCOVERY_PREFIX + "/status");
    c.publish(DISCOVERY_PREFIX + "/device/" + id + "/config", discovery(), true);
    c.publish(base + "/availability", "online", true);
    main.post(this::publishAll);
  }

  @Override
  public void onMessage(String topic, String payload) {
    String p = payload.trim();
    if (topic.equals(DISCOVERY_PREFIX + "/status")) {
      // Home Assistant restarted: send the config and states again.
      if ("online".equals(p)) {
        try {
          client.publish(DISCOVERY_PREFIX + "/device/" + id + "/config", discovery(), true);
          client.publish(base + "/availability", "online", true);
        } catch (IOException e) {
          Log.w(TAG, "Rediscovery failed: " + e.getMessage());
        }
        main.post(this::publishAll);
      }
      return;
    }
    if (!topic.startsWith(base + "/") || !topic.endsWith("/set")) return;
    final String entity = topic.substring(base.length() + 1, topic.length() - 4);
    Log.i(TAG, "Command " + entity + " " + (p.length() > 16 ? p.substring(0, 16) : p));
    main.post(() -> {
      switch (entity) {
        case "screen":
          if ("ON".equalsIgnoreCase(p) || "OFF".equalsIgnoreCase(p)) host.setScreen("ON".equalsIgnoreCase(p));
          break;
        case "brightness":
          try {
            host.setBrightness(Math.max(1, Math.min(100, Math.round(Float.parseFloat(p)))));
          } catch (NumberFormatException e) {
            Log.w(TAG, "Bad brightness");
          }
          break;
        case "auto_brightness":
          if ("ON".equalsIgnoreCase(p) || "OFF".equalsIgnoreCase(p)) host.setAutoBrightness("ON".equalsIgnoreCase(p));
          break;
        case "reload":
          host.reloadDashboard();
          return;
        default:
          return;
      }
      screenChanged(); // report what actually happened, so Home Assistant's state round-trips
    });
  }

  /** One device discovery message (Home Assistant 2024.11+) for every entity. */
  private String discovery() {
    try {
      JSONObject dev = new JSONObject()
          .put("ids", new org.json.JSONArray().put(id))
          .put("name", name)
          .put("mf", Build.MANUFACTURER)
          .put("mdl", Build.MODEL)
          .put("sw", "Home HQ kiosk " + version());
      JSONObject cmps = new JSONObject()
          .put("screen", entity("switch", "Screen", "screen", true).put("icon", "mdi:monitor"))
          .put("brightness", entity("number", "Screen brightness", "brightness", true)
              .put("min", 1).put("max", 100).put("step", 1).put("unit_of_meas", "%")
              .put("mode", "slider").put("icon", "mdi:brightness-6"))
          .put("auto_brightness", entity("switch", "Auto brightness", "auto_brightness", true)
              .put("icon", "mdi:brightness-auto").put("ent_cat", "config"))
          .put("illuminance", entity("sensor", "Illuminance", "illuminance", false)
              .put("dev_cla", "illuminance").put("unit_of_meas", "lx").put("stat_cla", "measurement"))
          .put("moved", entity("binary_sensor", "Moved", "moved", false).put("dev_cla", "moving"))
          .put("touched", entity("binary_sensor", "Touched", "touched", false)
              .put("dev_cla", "occupancy").put("icon", "mdi:gesture-tap"))
          .put("reload", new JSONObject().put("p", "button").put("name", "Reload dashboard")
              .put("uniq_id", id + "_reload").put("cmd_t", base + "/reload/set")
              .put("pl_prs", "PRESS").put("icon", "mdi:reload"));
      return new JSONObject()
          .put("dev", dev)
          .put("o", new JSONObject().put("name", "Home HQ kiosk").put("sw", version()))
          .put("avty_t", base + "/availability")
          .put("qos", 0)
          .put("cmps", cmps)
          .toString();
    } catch (JSONException e) {
      throw new IllegalStateException(e);
    }
  }

  private JSONObject entity(String platform, String entityName, String key, boolean command) throws JSONException {
    JSONObject o = new JSONObject().put("p", platform).put("name", entityName)
        .put("uniq_id", id + "_" + key).put("stat_t", base + "/" + key);
    if (command) o.put("cmd_t", base + "/" + key + "/set");
    return o;
  }

  private String version() {
    try {
      return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
    } catch (Exception e) {
      return "?";
    }
  }
}
