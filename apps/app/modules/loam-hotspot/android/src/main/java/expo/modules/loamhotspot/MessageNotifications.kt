package expo.modules.loamhotspot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Android notifications for new messages to the host phone's own person, shown while LOAM is in the
 * background (apps/app/src/lib/message-notifications.ts decides when, and supplies every word in the app's
 * language). One notification per conversation, replaced by the next message there. A tap opens LOAM at
 * that conversation: the conversation key rides the launch intent as [EXTRA_CONVERSATION].
 *
 * The "Messages" channel uses Android's default sound and vibration, which the person changes (or turns
 * off) in Android's settings for LOAM. On the lock screen only [publicTitle]/[publicText] show unless the
 * person allows private content there. Best-effort throughout: a failure is logged, never thrown.
 */
object MessageNotifications {
  private const val TAG = "LoamMessages"
  private const val CHANNEL_ID = "loam-messages"
  private const val NOTIFICATION_TAG = "loam-message"
  const val EXTRA_CONVERSATION = "loam.conversation"

  /** Everything one notification shows, already translated. */
  data class Content(
    val conversation: String,
    val title: String,
    val text: String,
    val count: Int,
    val publicTitle: String,
    val publicText: String,
    val channelName: String,
    val channelDescription: String,
  )

  fun show(context: Context, content: Content) {
    try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        // Re-creating the channel only updates its name and description; the person's own sound,
        // vibration and importance choices for it are kept.
        val channel =
          NotificationChannel(CHANNEL_ID, content.channelName, NotificationManager.IMPORTANCE_HIGH).apply {
            description = content.channelDescription
            enableVibration(true)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
          }
        manager.createNotificationChannel(channel)
      }

      val id = content.conversation.hashCode()
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        putExtra(EXTRA_CONVERSATION, content.conversation)
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      // One PendingIntent per conversation (the request code), so each notification opens its own.
      val contentIntent =
        launch?.let {
          PendingIntent.getActivity(
            context,
            id,
            it,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          )
        }

      val publicVersion =
        builder(context)
          .setContentTitle(content.publicTitle)
          .setContentText(content.publicText)
          .setSmallIcon(R.drawable.loam_host_notification)
          .build()

      val notification =
        builder(context)
          .setContentTitle(content.title)
          .setContentText(content.text)
          .setStyle(Notification.BigTextStyle().bigText(content.text))
          .setSmallIcon(R.drawable.loam_host_notification)
          .setCategory(Notification.CATEGORY_MESSAGE)
          .setVisibility(Notification.VISIBILITY_PRIVATE)
          .setPublicVersion(publicVersion)
          .setNumber(content.count)
          .setShowWhen(true)
          .setWhen(System.currentTimeMillis())
          .setAutoCancel(true)
      if (contentIntent != null) {
        notification.setContentIntent(contentIntent)
      }
      manager.notify(NOTIFICATION_TAG, id, notification.build())
    } catch (error: Exception) {
      Log.w(TAG, "Couldn't show a message notification", error)
    }
  }

  /** Remove every message notification (LOAM came to the front, so the person can see the messages). */
  fun clearAll(context: Context) {
    try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      for (active in manager.activeNotifications) {
        if (active.tag == NOTIFICATION_TAG) {
          manager.cancel(NOTIFICATION_TAG, active.id)
        }
      }
    } catch (error: Exception) {
      Log.w(TAG, "Couldn't clear message notifications", error)
    }
  }

  private fun builder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL)
    }
}
