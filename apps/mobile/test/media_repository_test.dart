import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/recording/media_contracts.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';

import 'support/http_test_support.dart';

const _apiBase = 'https://api.example.test/api/v1';
const _userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _meetingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const _mediaId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void main() {
  test(
    'media repository preserves idempotency and typed rejected finalization',
    () async {
      final storage = InMemoryCredentialStorage();
      final client = _MediaClient();
      final api = ApiClient(
        baseUri: Uri.parse(_apiBase),
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');
      final repository = MediaRepository(api: api);

      final intent = await repository.createUploadIntent(
        _meetingId,
        MediaUploadRequest(
          sourceType: MediaSourceType.upload,
          originalFilename: 'meeting.wav',
          contentType: 'audio/wav',
          expectedSizeBytes: 3,
        ),
        idempotencyKey: 'upload-key',
      );
      expect(intent.mediaId, _mediaId);
      expect(intent.hasUploadCapability, isTrue);
      expect(
        client.requests
            .singleWhere(
              (request) => request.url.path.endsWith('/media/uploads'),
            )
            .headers['Idempotency-Key'],
        'upload-key',
      );

      final rejected = await repository.finalizeUpload(_meetingId, _mediaId);
      expect(rejected.status, MediaStatus.rejected);
      expect(rejected.accepted, isFalse);
      expect(rejected.failureCode, 'MEDIA_FORMAT_UNSUPPORTED');
    },
  );

  test('media mutation failures are classified without retrying', () async {
    final storage = InMemoryCredentialStorage();
    final client = _MediaClient()..denyUpload = true;
    final api = ApiClient(
      baseUri: Uri.parse(_apiBase),
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);
    await api.initialize();
    await api.signIn('user@example.test', 'password');

    await expectLater(
      MediaRepository(api: api).createUploadIntent(
        _meetingId,
        MediaUploadRequest(
          sourceType: MediaSourceType.recording,
          originalFilename: 'meeting.wav',
          contentType: 'audio/wav',
          expectedSizeBytes: 3,
        ),
        idempotencyKey: 'upload-key',
      ),
      throwsA(
        isA<MediaRepositoryFailure>()
            .having(
              (failure) => failure.category,
              'category',
              MediaFailureCategory.authorization,
            )
            .having(
              (failure) => failure.mutationOutcome,
              'mutationOutcome',
              MediaMutationOutcome.rejected,
            ),
      ),
    );
  });
}

class _MediaClient extends http.BaseClient {
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  int loginCount = 0;
  bool denyUpload = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      loginCount++;
      return jsonResponse(
        200,
        successEnvelope(<String, dynamic>{
          'accessToken': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
          'refreshToken': 'refresh-token',
          'tokenType': 'Bearer',
          'expiresIn': 600,
        }),
      );
    }
    if (path.endsWith('/auth/me')) {
      return jsonResponse(
        200,
        successEnvelope(<String, dynamic>{
          'userId': _userId,
          'email': 'user@example.test',
          'displayName': 'User',
          'globalRole': 'EMPLOYEE',
          'accountStatus': 'ACTIVE',
          'primaryOrgUnitId': null,
          'directoryManagementScope': <String, dynamic>{
            'allUnits': false,
            'unitIds': <String>[],
          },
          'session': <String, dynamic>{
            'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'clientType': 'MOBILE',
            'createdAt': '2026-11-24T12:00:00Z',
            'lastSeenAt': null,
            'absoluteExpiresAt': '2026-12-24T12:00:00Z',
          },
        }),
      );
    }
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }
    if (path.endsWith('/media/uploads')) {
      if (denyUpload) {
        return jsonResponse(
          403,
          errorEnvelope('MEDIA_FORBIDDEN', 'Organizer access required.'),
        );
      }
      return jsonResponse(
        201,
        successEnvelope(<String, dynamic>{
          'mediaId': _mediaId,
          'status': 'PENDING_UPLOAD',
          'uploadUrl': 'https://storage.example.test/object?signature=secret',
          'expiresAt': '2026-12-24T12:00:00Z',
          'requiredContentType': 'audio/wav',
        }),
      );
    }
    if (path.endsWith('/finalize')) {
      return jsonResponse(
        200,
        successEnvelope(<String, dynamic>{
          'id': _mediaId,
          'meetingId': _meetingId,
          'sourceType': 'UPLOAD',
          'status': 'REJECTED',
          'originalFilename': 'meeting.wav',
          'contentType': 'audio/wav',
          'sizeBytes': null,
          'durationMs': null,
          'sha256': null,
          'createdAt': '2026-11-24T12:00:00Z',
          'availableAt': null,
          'failureCode': 'MEDIA_FORMAT_UNSUPPORTED',
        }),
      );
    }
    throw StateError('Unexpected request $path');
  }
}
