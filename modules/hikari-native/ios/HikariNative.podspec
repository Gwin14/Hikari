Pod::Spec.new do |s|
  s.name           = 'HikariNative'
  s.version        = '1.0.0'
  s.summary        = 'RAW decoding, encoding, metadata, segmentation and PhotoKit editing for Hikari'
  s.description    = 'Native image pipeline helpers for the Hikari photo editor'
  s.author         = 'Hikari'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = 'MIT'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreImage', 'ImageIO', 'Photos', 'Vision', 'UniformTypeIdentifiers', 'CoreVideo'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
