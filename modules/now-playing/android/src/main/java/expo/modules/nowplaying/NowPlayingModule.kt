package expo.modules.nowplaying

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.net.URL

// Android implementation of the now-playing bridge.
//
// expo-av owns the audio + background playback; this module owns the
// lock-screen / notification media surface that expo-av does not provide:
// a MediaSession (transport callbacks + metadata) plus a MediaStyle
// notification that renders the song's cover and prev/play-pause/next.
//
// The PlaybackState advertises ONLY play / pause / skip-next / skip-previous
// — never FAST_FORWARD / REWIND / SEEK_TO — so the system media controls
// show prev/next TRACK buttons instead of the default rewind/forward arrows.

private const val CHANNEL_ID = "boulevard_now_playing"
private const val NOTIFICATION_ID = 1947
private const val SESSION_TAG = "BoulevardNowPlaying"

private const val ACTION_PLAY = "io.boulevard.nowplaying.PLAY"
private const val ACTION_PAUSE = "io.boulevard.nowplaying.PAUSE"
private const val ACTION_NEXT = "io.boulevard.nowplaying.NEXT"
private const val ACTION_PREVIOUS = "io.boulevard.nowplaying.PREVIOUS"

class NowPlayingMetadata : Record {
  @Field var title: String = ""
  @Field var artist: String = ""
  @Field var artworkUrl: String? = null
}

class NowPlayingModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())

  private var mediaSession: MediaSession? = null
  private var receiver: BroadcastReceiver? = null
  private var contentIntent: PendingIntent? = null

  // Cached now-playing fields. MediaMetadata is immutable, so it is rebuilt
  // from these whenever any of them changes.
  private var title: String = ""
  private var artist: String = ""
  private var artwork: Bitmap? = null
  private var durationMs: Long = 0
  private var positionMs: Long = 0
  private var isPlaying: Boolean = false
  // Bumped per setMetadata; a stale artwork download is discarded against it.
  private var artworkToken = 0

  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("NowPlaying")

    Events("onRemoteCommand")

    Function("setMetadata") { metadata: NowPlayingMetadata ->
      mainHandler.post { applyMetadata(metadata) }
    }

    Function("setPlaybackState") { playing: Boolean, position: Double, duration: Double ->
      mainHandler.post { applyPlaybackState(playing, position, duration) }
    }

    Function("clear") {
      mainHandler.post { clearSession() }
    }

    OnDestroy {
      mainHandler.post { releaseSession() }
    }
  }

  // MARK: - Session lifecycle

  private fun ensureSession(): MediaSession? {
    val ctx = context ?: return null
    mediaSession?.let { return it }

    val session = MediaSession(ctx, SESSION_TAG)
    // The system lock-screen media controls invoke these callbacks directly.
    session.setCallback(object : MediaSession.Callback() {
      override fun onPlay() = emit("play")
      override fun onPause() = emit("pause")
      override fun onSkipToNext() = emit("next")
      override fun onSkipToPrevious() = emit("previous")
    })

    ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let { launch ->
      val pi = PendingIntent.getActivity(ctx, 0, launch, pendingIntentFlags())
      session.setSessionActivity(pi)
      contentIntent = pi
    }

    mediaSession = session
    registerReceiver(ctx)
    createChannel(ctx)
    return session
  }

  // Routes notification-button presses through the session controller so the
  // MediaSession.Callback stays the single source of remote-command events.
  private fun registerReceiver(ctx: Context) {
    if (receiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, intent: Intent?) {
        val controls = mediaSession?.controller?.transportControls ?: return
        when (intent?.action) {
          ACTION_PLAY -> controls.play()
          ACTION_PAUSE -> controls.pause()
          ACTION_NEXT -> controls.skipToNext()
          ACTION_PREVIOUS -> controls.skipToPrevious()
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction(ACTION_PLAY)
      addAction(ACTION_PAUSE)
      addAction(ACTION_NEXT)
      addAction(ACTION_PREVIOUS)
    }
    if (Build.VERSION.SDK_INT >= 33) {
      ctx.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(r, filter)
    }
    receiver = r
  }

  private fun releaseSession() {
    receiver?.let { r ->
      try { context?.unregisterReceiver(r) } catch (_: Exception) { /* not registered */ }
    }
    receiver = null
    cancelNotification()
    mediaSession?.release()
    mediaSession = null
  }

  // MARK: - Metadata + playback

  private fun applyMetadata(metadata: NowPlayingMetadata) {
    val session = ensureSession() ?: return
    title = metadata.title
    artist = metadata.artist
    artwork = null
    artworkToken += 1
    val token = artworkToken

    session.isActive = true
    updateSessionMetadata()
    postNotification()

    val url = metadata.artworkUrl
    if (!url.isNullOrEmpty()) loadArtwork(url, token)
  }

  private fun loadArtwork(url: String, token: Int) {
    Thread {
      val bmp = try {
        URL(url).openStream().use { BitmapFactory.decodeStream(it) }
      } catch (_: Exception) {
        null
      } ?: return@Thread
      mainHandler.post {
        // A newer song was set while this download was in flight — discard.
        if (token != artworkToken) return@post
        artwork = bmp
        updateSessionMetadata()
        postNotification()
      }
    }.start()
  }

  private fun applyPlaybackState(playing: Boolean, position: Double, duration: Double) {
    val session = ensureSession() ?: return
    val newDuration = (duration * 1000).toLong()
    val durationChanged = newDuration > 0 && newDuration != durationMs
    if (newDuration > 0) durationMs = newDuration
    positionMs = (position * 1000).toLong()
    val playStateChanged = playing != isPlaying
    isPlaying = playing

    val state = PlaybackState.Builder()
      .setActions(
        PlaybackState.ACTION_PLAY or
          PlaybackState.ACTION_PAUSE or
          PlaybackState.ACTION_PLAY_PAUSE or
          PlaybackState.ACTION_SKIP_TO_NEXT or
          PlaybackState.ACTION_SKIP_TO_PREVIOUS
      )
      .setState(
        if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
        positionMs,
        if (playing) 1f else 0f,
      )
      .build()
    session.setPlaybackState(state)
    session.isActive = true

    // Duration arrives a beat after playback starts — refresh the metadata
    // once it is known so the scrubber length is correct.
    if (durationChanged) updateSessionMetadata()
    // The notification only needs re-posting when the play/pause icon flips
    // or the scrubber length changes — never on every position tick.
    if (playStateChanged || durationChanged) postNotification()
  }

  private fun updateSessionMetadata() {
    val session = mediaSession ?: return
    val builder = MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
      .putString(MediaMetadata.METADATA_KEY_ALBUM, "Boulevard")
    if (durationMs > 0) {
      builder.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
    }
    artwork?.let {
      builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it)
      builder.putBitmap(MediaMetadata.METADATA_KEY_ART, it)
    }
    session.setMetadata(builder.build())
  }

  // MARK: - Notification

  private fun postNotification() {
    val ctx = context ?: return
    val session = mediaSession ?: return

    val builder = if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(ctx, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(ctx)
    }

    val playPause = if (isPlaying) {
      buildAction(ctx, android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE)
    } else {
      buildAction(ctx, android.R.drawable.ic_media_play, "Play", ACTION_PLAY)
    }

    val style = Notification.MediaStyle()
      .setMediaSession(session.sessionToken)
      .setShowActionsInCompactView(0, 1, 2)

    builder
      .setStyle(style)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(title)
      .setContentText(artist)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(isPlaying)
      .setOnlyAlertOnce(true)
      .addAction(buildAction(ctx, android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS))
      .addAction(playPause)
      .addAction(buildAction(ctx, android.R.drawable.ic_media_next, "Next", ACTION_NEXT))

    artwork?.let { builder.setLargeIcon(it) }
    contentIntent?.let { builder.setContentIntent(it) }

    notificationManager(ctx).notify(NOTIFICATION_ID, builder.build())
  }

  private fun buildAction(
    ctx: Context,
    iconRes: Int,
    label: String,
    intentAction: String,
  ): Notification.Action {
    val intent = Intent(intentAction).setPackage(ctx.packageName)
    val pendingIntent = PendingIntent.getBroadcast(
      ctx,
      intentAction.hashCode(),
      intent,
      pendingIntentFlags(),
    )
    val icon = Icon.createWithResource(ctx, iconRes)
    return Notification.Action.Builder(icon, label, pendingIntent).build()
  }

  private fun createChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = notificationManager(ctx)
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Now Playing",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
  }

  private fun cancelNotification() {
    val ctx = context ?: return
    notificationManager(ctx).cancel(NOTIFICATION_ID)
  }

  private fun clearSession() {
    isPlaying = false
    artwork = null
    artworkToken += 1
    cancelNotification()
    mediaSession?.let {
      it.setPlaybackState(
        PlaybackState.Builder()
          .setState(PlaybackState.STATE_STOPPED, 0, 0f)
          .build(),
      )
      it.isActive = false
    }
  }

  // MARK: - Helpers

  private fun emit(command: String) {
    sendEvent("onRemoteCommand", mapOf("command" to command))
  }

  private fun notificationManager(ctx: Context): NotificationManager =
    ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun pendingIntentFlags(): Int =
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
}
