import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

import 'support/http_test_support.dart';

void main() {
  test('the dependency holder closes owned resources exactly once', () {
    final client = NoNetworkHttpClient();
    final api = TrackingApiClient(client);
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );

    dependencies.dispose();
    dependencies.dispose();

    expect(api.disposeCalls, 1);
    expect(client.closeCalls, 1);
    expect(dependencies.meetings, isA<MeetingRepository>());
    expect(dependencies.meetingInvalidation.isDisposed, isTrue);
    expect(dependencies.isDisposed, isTrue);
  });

  test('the production composition factory injects its dependencies', () {
    final client = NoNetworkHttpClient();
    final credentials = InMemoryCredentialStorage();
    final preferences = InMemoryAppearancePreferences();
    final dependencies = AppDependencies.create(
      apiBaseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: credentials,
      appearancePreferences: preferences,
    );

    expect(
      dependencies.api.baseUri,
      Uri.parse('https://api.example.test/api/v1'),
    );
    expect(dependencies.appearancePreferences, same(preferences));
    expect(dependencies.meetings, isA<MeetingRepository>());

    dependencies.dispose();
    expect(client.closeCalls, 1);
  });
}

class TrackingApiClient extends ApiClient {
  int disposeCalls = 0;

  TrackingApiClient(NoNetworkHttpClient client)
    : super(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );

  @override
  void dispose() {
    disposeCalls++;
    super.dispose();
  }
}
