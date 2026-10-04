package com.fairshare.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Foreground service backing the Settings keep-alive toggle. */
public class KeepAliveService extends Service {
    public static final String CHANNEL_ID = "fairshare_keep_alive";
    public static final int NOTIFICATION_ID = 4201;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, pendingIntentFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("FairShare")
                .setContentText("Staying connected to your groups in the background")
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        int serviceType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceType);
        } catch (Exception e) {
            // Android 12+ can refuse a foreground-service start (ForegroundServiceStartNotAllowedException).
            // Not fatal - the app just loses the background keep-alive this session instead of crashing.
            stopSelf();
            return START_NOT_STICKY;
        }

        // a sticky restart after the process died brought the notification back with no WebView behind it
        return START_NOT_STICKY;
    }

    // targetSdk 35+ gives dataSync 6h per 24h. Not stopping here crashes the app.
    @Override
    public void onTimeout(int startId, int fgsType) {
        KeepAlivePlugin.onServiceStopped("timeout");
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        KeepAlivePlugin.onServiceStopped("stopped");
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Persistent Connection", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Keeps FairShare connected to peers while the app is in the background");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
