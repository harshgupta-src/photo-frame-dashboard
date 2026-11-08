package com.wesbos.homehq;

import android.app.admin.DeviceAdminReceiver;

/**
 * Device admin with only the force-lock policy, so Home Assistant can turn the screen fully off
 * (DevicePolicyManager.lockNow). Opt in over USB:
 *   adb shell dpm set-active-admin com.wesbos.homehq/.ScreenAdmin
 * Without it, "screen off" blacks the page out at the lowest backlight and a tap wakes it.
 */
public class ScreenAdmin extends DeviceAdminReceiver {}
