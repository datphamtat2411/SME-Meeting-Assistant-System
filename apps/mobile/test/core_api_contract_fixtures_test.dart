import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/api_response_decoder.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';

const _meetingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _meetingEtag = '"m-$_meetingId-7"';
const _requestId = '11111111-1111-4111-8111-111111111111';

void main() {
  const decoder = ApiResponseDecoder();

  test(
    'decodes a Core API meeting detail DTO and server response metadata',
    () async {
      final result = _decode(
        decoder,
        await _fixture('meeting_detail_success.json'),
        headers: const <String, String>{
          'etag': _meetingEtag,
          'x-request-id': _requestId,
        },
      );
      final meeting = Meeting.fromJson(result.objectData(), response: result);

      expect(meeting.id, _meetingId);
      expect(meeting.title, 'Weekly operations review');
      expect(meeting.description, isNull);
      expect(meeting.roomId, isNull);
      expect(meeting.scheduledStartAt!.isUtc, isTrue);
      expect(meeting.display, isNull);
      expect(result.etag, _meetingEtag);
      expect(result.requestId, _requestId);
      expect(result.responseRequestId, _requestId);
    },
  );

  test(
    'decodes the Core API list projection and complete pagination metadata',
    () async {
      final result = _decode(
        decoder,
        await _fixture('meeting_list_page_success.json'),
      );
      final page = PagedCollection<Meeting>.fromResult(
        result,
        (raw) => Meeting.fromListJson(raw, response: result),
        requestedPage: 0,
        requestedSize: 20,
      );

      expect(page.items, hasLength(1));
      expect(page.items.single.organizerName, 'Lan Nguyen');
      expect(page.items.single.roomName, isNull);
      expect(page.items.single.display!.participantCount, 1);
      expect(page.totalElements, 1);
      expect(page.totalPages, 1);
      expect(page.hasNext, isFalse);
      expect(page.hasPrevious, isFalse);
      expect(result.requestId, '22222222-2222-4222-8222-222222222222');
    },
  );

  test('retains the structured Common API validation error contract', () async {
    final failure = _decodeFailure(
      decoder,
      422,
      await _fixture('validation_failed.json'),
      responseRequestId: '33333333-3333-4333-8333-333333333333',
    );

    expect(failure.code, 'VALIDATION_FAILED');
    expect(failure.validationFailure, isTrue);
    expect(failure.status, 422);
    expect(failure.errors, hasLength(1));
    expect(failure.errors.single.field, 'title');
    expect(failure.errors.single.code, 'NOT_BLANK');
    expect(failure.errors.single.message, 'must not be blank');
    expect(failure.requestId, '33333333-3333-4333-8333-333333333333');
    expect(failure.responseRequestId, failure.requestId);
  });

  test('distinguishes authentication and authorization failures', () async {
    final authentication = _decodeFailure(
      decoder,
      401,
      await _fixture('authentication_required.json'),
    );
    final authorization = _decodeFailure(
      decoder,
      403,
      await _fixture('authorization_forbidden.json'),
    );

    expect(authentication.code, 'AUTH_REQUIRED');
    expect(authentication.authenticationFailure, isTrue);
    expect(authentication.status, 401);
    expect(authorization.code, 'AUTHZ_FORBIDDEN');
    expect(authorization.authorizationFailure, isTrue);
    expect(authorization.status, 403);
  });

  test('uses a response ETag for If-Match and preserves a server concurrency failure', () async {
    final client = FixtureHttpClient(<FixtureHttpResponse>[
      FixtureHttpResponse(
        statusCode: 200,
        body: await _fixture('meeting_detail_success.json'),
        headers: const <String, String>{
          'etag': _meetingEtag,
          'x-request-id': _requestId,
        },
      ),
      FixtureHttpResponse(
        statusCode: 412,
        body: await _fixture('precondition_failed.json'),
        headers: const <String, String>{
          'x-request-id': '66666666-6666-4666-8666-666666666666',
        },
      ),
    ]);
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: InMemoryCredentialStorage(),
    );
    addTearDown(api.dispose);

    final current = await api.get('/meetings/$_meetingId');
    expect(current.etag, _meetingEtag);

    await expectLater(
      api.patch(
        '/meetings/$_meetingId',
        const <String, dynamic>{'title': 'Updated review'},
        headers: <String, String>{'If-Match': current.etag!},
      ),
      throwsA(
        isA<ApiFailure>()
            .having((failure) => failure.status, 'status', 412)
            .having((failure) => failure.code, 'code', 'PRECONDITION_FAILED')
            .having(
              (failure) => failure.concurrencyFailure,
              'concurrency',
              isTrue,
            )
            .having(
              (failure) => failure.requestId,
              'requestId',
              '66666666-6666-4666-8666-666666666666',
            ),
      ),
    );

    expect(client.requests, hasLength(2));
    expect(client.requests[0].headers['X-Auth-Transport'], 'mobile');
    expect(client.requests[1].headers['X-Auth-Transport'], 'mobile');
    expect(client.requests[1].headers['If-Match'], _meetingEtag);
  });

  test(
    'preserves the server precondition-required error without inventing a tag',
    () async {
      final failure = _decodeFailure(
        decoder,
        428,
        await _fixture('precondition_required.json'),
      );

      expect(failure.status, 428);
      expect(failure.code, 'PRECONDITION_REQUIRED');
      expect(failure.concurrencyFailure, isTrue);
    },
  );
}

Future<Map<String, dynamic>> _fixture(String name) async {
  final content = await File('test/fixtures/core_api/$name').readAsString();
  return jsonDecode(content) as Map<String, dynamic>;
}

ApiResult _decode(
  ApiResponseDecoder decoder,
  Map<String, dynamic> envelope, {
  Map<String, String> headers = const <String, String>{},
}) => decoder.decode(
  statusCode: 200,
  headers: headers,
  bodyBytes: utf8.encode(jsonEncode(envelope)),
);

ApiFailure _decodeFailure(
  ApiResponseDecoder decoder,
  int statusCode,
  Map<String, dynamic> envelope, {
  String? responseRequestId,
}) {
  try {
    decoder.decode(
      statusCode: statusCode,
      headers: <String, String>{
        if (responseRequestId != null) 'x-request-id': responseRequestId,
      },
      bodyBytes: utf8.encode(jsonEncode(envelope)),
    );
  } on ApiFailure catch (failure) {
    return failure;
  }
  throw StateError('Expected an API error fixture for HTTP $statusCode.');
}

class FixtureHttpResponse {
  const FixtureHttpResponse({
    required this.statusCode,
    required this.body,
    this.headers = const <String, String>{},
  });

  final int statusCode;
  final Map<String, dynamic> body;
  final Map<String, String> headers;
}

class FixtureHttpClient extends http.BaseClient {
  FixtureHttpClient(this._responses);

  final List<FixtureHttpResponse> _responses;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final fixture = _responses.removeAt(0);
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(jsonEncode(fixture.body))),
      fixture.statusCode,
      headers: fixture.headers,
    );
  }
}
