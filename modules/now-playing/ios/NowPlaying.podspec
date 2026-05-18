Pod::Spec.new do |s|
  s.name           = 'NowPlaying'
  s.version        = '1.0.0'
  s.summary        = 'Boulevard lock-screen now-playing controls'
  s.description    = 'Bridges Boulevard playback into MPNowPlayingInfoCenter and MPRemoteCommandCenter.'
  s.author         = 'Boulevard'
  s.homepage       = 'https://boulevard.io'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '13.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
