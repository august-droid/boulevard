import ExpoModulesCore
import MediaPlayer
import UIKit

// iOS implementation of the now-playing bridge.
//
// expo-av owns the audio session + background playback; this module owns the
// lock-screen / Control Center surface that expo-av does not touch:
//   • MPNowPlayingInfoCenter — title / artist / artwork / scrubber.
//   • MPRemoteCommandCenter  — play / pause / previous-track / next-track.
//
// The ±N-second skip and seek commands are explicitly DISABLED so the lock
// screen renders prev/next TRACK buttons instead of the default skip arrows.
public class NowPlayingModule: Module {
  // Bumped on every setMetadata call; an artwork download that resolves
  // against a stale token (the song changed mid-download) is discarded.
  private var artworkToken = 0
  private var commandsRegistered = false

  public func definition() -> ModuleDefinition {
    Name("NowPlaying")

    Events("onRemoteCommand")

    OnCreate {
      DispatchQueue.main.async { [weak self] in
        self?.registerRemoteCommands()
      }
    }

    Function("setMetadata") { (metadata: NowPlayingMetadata) in
      DispatchQueue.main.async { [weak self] in
        self?.applyMetadata(metadata)
      }
    }

    Function("setPlaybackState") { (isPlaying: Bool, position: Double, duration: Double) in
      DispatchQueue.main.async { [weak self] in
        self?.applyPlaybackState(isPlaying: isPlaying, position: position, duration: duration)
      }
    }

    Function("clear") {
      DispatchQueue.main.async { [weak self] in
        self?.clearInfo()
      }
    }
  }

  // MARK: - Remote commands

  private func registerRemoteCommands() {
    guard !commandsRegistered else { return }
    commandsRegistered = true
    let center = MPRemoteCommandCenter.shared()

    // Enabled transport — play / pause / prev-track / next-track.
    center.playCommand.isEnabled = true
    center.playCommand.addTarget { [weak self] _ in
      self?.sendEvent("onRemoteCommand", ["command": "play"])
      return .success
    }
    center.pauseCommand.isEnabled = true
    center.pauseCommand.addTarget { [weak self] _ in
      self?.sendEvent("onRemoteCommand", ["command": "pause"])
      return .success
    }
    center.togglePlayPauseCommand.isEnabled = true
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      // The JS side maps play/pause to a single togglePlay(), so the headset
      // toggle just needs to land as either one.
      self?.sendEvent("onRemoteCommand", ["command": "play"])
      return .success
    }
    center.nextTrackCommand.isEnabled = true
    center.nextTrackCommand.addTarget { [weak self] _ in
      self?.sendEvent("onRemoteCommand", ["command": "next"])
      return .success
    }
    center.previousTrackCommand.isEnabled = true
    center.previousTrackCommand.addTarget { [weak self] _ in
      self?.sendEvent("onRemoteCommand", ["command": "previous"])
      return .success
    }

    // Disabled — the ±N-second skip / seek transport. Turning these OFF is
    // what makes iOS render prev/next TRACK buttons on the lock screen.
    center.skipForwardCommand.isEnabled = false
    center.skipBackwardCommand.isEnabled = false
    center.seekForwardCommand.isEnabled = false
    center.seekBackwardCommand.isEnabled = false
    center.changePlaybackPositionCommand.isEnabled = false
  }

  // MARK: - Now-playing info

  private func applyMetadata(_ metadata: NowPlayingMetadata) {
    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
    info[MPMediaItemPropertyTitle] = metadata.title
    info[MPMediaItemPropertyArtist] = metadata.artist
    info[MPMediaItemPropertyAlbumTitle] = "Boulevard"
    // Drop the previous song's cover until the new one finishes downloading.
    info[MPMediaItemPropertyArtwork] = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info

    artworkToken += 1
    if let urlString = metadata.artworkUrl, let url = URL(string: urlString) {
      loadArtwork(url, token: artworkToken)
    }
  }

  private func loadArtwork(_ url: URL, token: Int) {
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let self = self,
            let data = data,
            let image = UIImage(data: data) else { return }
      DispatchQueue.main.async {
        // A newer song was set while this download was in flight — discard.
        guard token == self.artworkToken else { return }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      }
    }.resume()
  }

  private func applyPlaybackState(isPlaying: Bool, position: Double, duration: Double) {
    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, position)
    if duration > 0 {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
  }

  private func clearInfo() {
    artworkToken += 1
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    MPNowPlayingInfoCenter.default().playbackState = .stopped
  }
}

struct NowPlayingMetadata: Record {
  @Field var title: String = ""
  @Field var artist: String = ""
  @Field var artworkUrl: String? = nil
}
