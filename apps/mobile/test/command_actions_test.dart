import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/command_actions.dart';

void main() {
  test('passes through a server-issued ETag unchanged', () {
    const serverEtag = '"m-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-7"';
    final response = ApiResult(
      const <String, dynamic>{},
      const <String, dynamic>{},
      serverEtag,
    );

    expect(requireEtag(response), serverEtag);
  });

  test(
    'fails closed when a response does not contain a server-issued ETag',
    () {
      final response = ApiResult(
        const <String, dynamic>{},
        const <String, dynamic>{},
        null,
        statusCode: 200,
        requestId: 'body-request',
        responseRequestId: 'header-request',
        timestamp: '2026-11-23T12:00:00Z',
        headers: const <String, String>{'x-request-id': 'header-request'},
      );

      expect(
        () => requireEtag(response),
        throwsA(
          isA<ApiFailure>()
              .having((failure) => failure.code, 'code', 'VERSION_MISSING')
              .having((failure) => failure.status, 'status', 200)
              .having(
                (failure) => failure.requestId,
                'requestId',
                'body-request',
              )
              .having(
                (failure) => failure.responseRequestId,
                'responseRequestId',
                'header-request',
              )
              .having(
                (failure) => failure.timestamp,
                'timestamp',
                '2026-11-23T12:00:00Z',
              )
              .having(
                (failure) => failure.headers['x-request-id'],
                'response header',
                'header-request',
              ),
        ),
      );
    },
  );

  test(
    'treats an empty response ETag as missing rather than fabricating one',
    () {
      const response = ApiResult(<String, dynamic>{}, <String, dynamic>{}, '');

      expect(
        () => requireEtag(response),
        throwsA(
          isA<ApiFailure>().having(
            (failure) => failure.code,
            'code',
            'VERSION_MISSING',
          ),
        ),
      );
    },
  );
}
