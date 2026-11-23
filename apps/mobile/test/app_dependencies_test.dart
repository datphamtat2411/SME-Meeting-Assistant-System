import 'package:http/http.dart' as http;
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';

void main() {
  test('the dependency holder closes owned resources exactly once', () {
    final client = TrackingHttpClient();
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
    expect(dependencies.isDisposed, isTrue);
  });

  test('the production composition factory injects its dependencies', () {
    final client = TrackingHttpClient();
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

    dependencies.dispose();
    expect(client.closeCalls, 1);
  });
}

class TrackingHttpClient extends http.BaseClient {
  int closeCalls = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    return Future<http.StreamedResponse>.error(
      UnsupportedError('No network is used by this test.'),
    );
  }

  @override
  void close() {
    closeCalls++;
  }
}

class TrackingApiClient extends ApiClient {
  int disposeCalls = 0;

  TrackingApiClient(http.Client client)
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
