package com.fairshare.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Bridges the JS keep-alive toggle to the native foreground service. */
@CapacitorPlugin(
    name = "KeepAlive",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class KeepAlivePlugin extends Plugin {
    private static boolean active = false;
    private static KeepAlivePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    // the service can stop on its own (timeout or a refused start), so the JS toggle has to hear about it
    static void onServiceStopped(String reason) {
        if (!active) return;
        active = false;
        if (instance != null) {
            JSObject data = new JSObject();
            data.put("reason", reason);
            instance.notifyListeners("stopped", data);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("notifications", call, "startAfterPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        // Even if the user denies POST_NOTIFICATIONS, still start the foreground
        // service - Android just won't show the notification, but the process
        // staying alive (the primary goal) doesn't depend on it.
        startService(call);
    }

    private void startService(PluginCall call) {
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        ContextCompat.startForegroundService(getContext(), intent);
        active = true;
        JSObject result = new JSObject();
        result.put("started", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // cleared first so onDestroy's onServiceStopped doesn't echo a "stopped" event back
        active = false;
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }

    @PluginMethod
    public void isActive(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", active);
        call.resolve(result);
    }
}
