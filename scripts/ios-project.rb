# One-time iOS project setup for App Store / TestFlight (idempotent):
#   ruby scripts/ios-project.rb
# - privacy manifest in the app bundle, entitlements file visible in Xcode
# - iPhone only (no iPad screenshots / multitasking orientations needed)
# - shared "App" scheme so CI (xcodebuild / fastlane) can build it
require 'xcodeproj'

root = File.expand_path('..', __dir__)
path = File.join(root, 'ios/App/App.xcodeproj')
project = Xcodeproj::Project.open(path)
target = project.targets.find { |t| t.name == 'App' } or abort 'App target not found'
group = project.main_group['App'] or abort 'App group not found'

privacy = group.files.find { |f| f.path == 'PrivacyInfo.xcprivacy' } || group.new_reference('PrivacyInfo.xcprivacy')
target.resources_build_phase.add_file_reference(privacy, true)
group.new_reference('App.entitlements') unless group.files.any? { |f| f.path == 'App.entitlements' }

target.build_configurations.each do |c|
  c.build_settings['TARGETED_DEVICE_FAMILY'] = '1'
  c.build_settings['MARKETING_VERSION'] = '1.0.0'
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  c.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(target, nil)
scheme.launch_action.build_configuration = 'Debug'
scheme.archive_action.build_configuration = 'Release'
scheme.save_as(path, 'App', true)
puts 'ios project: ok'
