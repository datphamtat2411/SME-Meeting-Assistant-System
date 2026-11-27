import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/api_response_decoder.dart';

const _requestId = 'request-123';
const _timestamp = '2026-11-23T12:34:56.789+02:00';

void main() {
  const decoder = ApiResponseDecoder();

  group('ApiResponseDecoder success responses', () {
    test('preserves object, array, scalar, and nullable payloads', () {
      final object = _decode(decoder, 200, <String, dynamic>{'value': 1});
      expect(object.objectData(), <String, dynamic>{'value': 1});
      expect(object.code, 'SUCCESS');
      expect(object.statusCode, 200);

      final array = _decode(decoder, 200, <dynamic>[1, 'two']);
      expect(array.arrayData(), <dynamic>[1, 'two']);

      final scalar = _decode(decoder, 201, 'created');
      expect(scalar.data, 'created');
      expect(scalar.nullableData<String>(), 'created');

      final nullable = _decode(decoder, 202, null);
      expect(nullable.data, isNull);
      expect(nullable.nullableData<String>(), isNull);
      expect(nullable.statusCode, 202);
    });

    test('preserves valid empty objects and arrays', () {
      final object = _decode(decoder, 200, <String, dynamic>{});
      expect(object.objectData(), isEmpty);

      final array = _decode(decoder, 200, <dynamic>[]);
      expect(array.arrayData(), isEmpty);
      expect(array.objectArrayData(), isEmpty);
    });

    test('retains response metadata and unknown compatible fields', () {
      final response = _decode(
        decoder,
        201,
        <String, dynamic>{'id': 'meeting-1'},
        headers: const <String, String>{
          'ETag': ' W/"opaque-token" ',
          'X-Request-Id': 'header-request-456',
          'Retry-After': '7',
        },
        meta: const <String, dynamic>{
          'requestId': _requestId,
          'timestamp': _timestamp,
          'pagination': <String, dynamic>{'hasNext': true},
          'futureMeta': <String, dynamic>{'revision': 9},
        },
        extraEnvelope: const <String, dynamic>{
          'futureEnvelopeField': 'accepted',
        },
      );

      expect(response.requestId, _requestId);
      expect(response.responseRequestId, 'header-request-456');
      expect(response.timestamp, _timestamp);
      expect(response.etag, ' W/"opaque-token" ');
      expect(response.headers['Retry-After'], '7');
      expect(response.meta['pagination'], <String, dynamic>{'hasNext': true});
      expect(response.meta['futureMeta'], <String, dynamic>{'revision': 9});
      expect(response.statusCode, 201);
    });

    test('does not reinterpret accepted work as completed processing', () {
      final response = _decode(decoder, 202, const <String, dynamic>{
        'status': 'ACCEPTED',
      });

      expect(response.statusCode, 202);
      expect(response.objectData()['status'], 'ACCEPTED');
    });
  });

  group('checked payload access', () {
    test('rejects object/list and nullable type mismatches', () {
      final listResult = _decode(decoder, 200, <dynamic>[]);
      expect(() => listResult.objectData(), throwsA(_invalidPayload));

      final objectResult = _decode(decoder, 200, <String, dynamic>{});
      expect(() => objectResult.arrayData(), throwsA(_invalidPayload));
      expect(() => objectResult.objectArrayData(), throwsA(_invalidPayload));
      expect(
        () => objectResult.nullableData<String>(),
        throwsA(_invalidPayload),
      );
    });

    test('rejects arrays containing non-object entries', () {
      final response = _decode(decoder, 200, <dynamic>[
        <String, dynamic>{'id': 'ok'},
        null,
      ]);

      expect(() => response.objectArrayData(), throwsA(_invalidPayload));
    });

    test(
      'retains originating HTTP status and response correlation context',
      () {
        final response = _decode(
          decoder,
          206,
          <dynamic>[
            <String, dynamic>{'id': 'ok'},
            null,
          ],
          headers: const <String, String>{
            'X-Request-Id': 'response-request-789',
          },
        );

        expect(
          () => response.objectArrayData(),
          throwsA(
            isA<ApiFailure>()
                .having(
                  (failure) => failure.code,
                  'code',
                  ApiFailure.invalidResponseCode,
                )
                .having((failure) => failure.status, 'status', 206)
                .having((failure) => failure.requestId, 'requestId', _requestId)
                .having(
                  (failure) => failure.responseRequestId,
                  'responseRequestId',
                  'response-request-789',
                )
                .having((failure) => failure.timestamp, 'timestamp', _timestamp)
                .having(
                  (failure) => failure.headers['X-Request-Id'],
                  'response header',
                  'response-request-789',
                )
                .having(
                  (failure) => failure.isTransportFailure,
                  'transport failure',
                  isFalse,
                ),
          ),
        );
      },
    );

    test(
      'uses local status semantics when no HTTP response context exists',
      () {
        const result = ApiResult(<dynamic>[], <String, dynamic>{}, null);

        expect(
          () => result.objectData(),
          throwsA(
            isA<ApiFailure>()
                .having(
                  (failure) => failure.code,
                  'code',
                  ApiFailure.invalidResponseCode,
                )
                .having((failure) => failure.status, 'status', 0)
                .having((failure) => failure.requestId, 'requestId', isNull)
                .having(
                  (failure) => failure.responseRequestId,
                  'responseRequestId',
                  isNull,
                )
                .having((failure) => failure.timestamp, 'timestamp', isNull)
                .having(
                  (failure) => failure.isTransportFailure,
                  'transport',
                  isFalse,
                ),
          ),
        );
      },
    );
  });

  group('ApiResponseDecoder error responses', () {
    const errorStatuses = <int>[
      400,
      401,
      403,
      404,
      409,
      412,
      422,
      428,
      429,
      500,
      502,
      503,
      504,
    ];

    for (final status in errorStatuses) {
      test('preserves structured API error status $status', () {
        final headers = <String, String>{
          'x-request-id': 'header-$status',
          if (status == 429) 'retry-after': '15',
        };
        final failure = _decodeFailure(
          decoder,
          status,
          _errorEnvelope('SERVER_DEFINED_$status', 'Safe message.'),
          headers: headers,
        );

        expect(failure.status, status);
        expect(failure.code, 'SERVER_DEFINED_$status');
        expect(failure.message, 'Safe message.');
        expect(failure.requestId, _requestId);
        expect(failure.responseRequestId, 'header-$status');
        expect(failure.timestamp, _timestamp);
        expect(failure.headers['x-request-id'], 'header-$status');
        expect(failure.retryAfter, status == 429 ? '15' : isNull);
        expect(failure.unauthorized, status == 401);
        expect(failure.permissionDenied, status == 403);
        expect(failure.missing, status == 404);
        expect(failure.conflict, status == 409 || status == 412);
        expect(failure.businessConflict, status == 409);
        expect(failure.concurrencyFailure, status == 412 || status == 428);
        expect(failure.validationFailure, status == 422);
        expect(failure.rateLimited, status == 429);
        expect(failure.serverFailure, status >= 500);
      });
    }

    test('preserves field and non-field validation errors', () {
      final failure = _decodeFailure(
        decoder,
        422,
        _errorEnvelope(
          'VALIDATION_FAILED',
          'The request is invalid.',
          errors: const <dynamic>[
            <String, dynamic>{
              'field': 'scheduledStartAt',
              'code': 'INVALID_TIME_RANGE',
              'message': 'Start time must be before end time.',
            },
            <String, dynamic>{
              'path': 'request',
              'code': 'BUSINESS_RULE',
              'message': 'The requested operation is not available.',
            },
          ],
        ),
      );

      expect(failure.errors, hasLength(2));
      expect(failure.errors.first.field, 'scheduledStartAt');
      expect(failure.errors.first.fieldPath, 'scheduledStartAt');
      expect(failure.errors.first.code, 'INVALID_TIME_RANGE');
      expect(
        failure.errors.first.message,
        'Start time must be before end time.',
      );
      expect(failure.errors.last.field, isNull);
      expect(failure.errors.last.path, 'request');
      expect(failure.errors.last.fieldPath, 'request');
    });

    test('retains Retry-After in both standard representations', () {
      final delta = _decodeFailure(
        decoder,
        429,
        _errorEnvelope('RATE_LIMIT_EXCEEDED', 'Try later.'),
        headers: const <String, String>{'retry-after': '120'},
      );
      expect(delta.retryAfter, '120');
      expect(delta.retryAfterDuration(), const Duration(seconds: 120));

      final date = _decodeFailure(
        decoder,
        503,
        _errorEnvelope('SERVICE_UNAVAILABLE', 'Try later.'),
        headers: const <String, String>{
          'retry-after': 'Mon, 23 Nov 2026 12:36:56 GMT',
        },
      );
      expect(
        date.retryAfterDuration(now: DateTime.utc(2026, 11, 23, 12, 34)),
        const Duration(minutes: 2, seconds: 56),
      );
    });

    test('uses a safe fallback when an API error omits its message', () {
      final envelope = _errorEnvelope('MEETING_LOCKED', '');
      envelope.remove('message');
      final failure = _decodeFailure(decoder, 409, envelope);

      expect(failure.code, 'MEETING_LOCKED');
      expect(failure.message, 'The operation could not be completed.');
    });
  });

  group('invalid and inconsistent responses', () {
    test('rejects malformed JSON without exposing body contents', () {
      final failure = _decodeFailure(
        decoder,
        502,
        const <int>[60, 104, 116, 109, 108, 62],
        headers: const <String, String>{'X-Request-Id': 'trusted-request'},
      );

      expect(failure.code, 'INVALID_RESPONSE');
      expect(failure.status, 502);
      expect(failure.requestId, 'trusted-request');
      expect(failure.responseRequestId, 'trusted-request');
      expect(failure.message, isNot(contains('<html>')));
    });

    test('rejects missing mandatory envelope and metadata fields', () {
      final invalidEnvelopes = <Map<String, dynamic>>[
        <String, dynamic>{'success': true},
        _successEnvelope(<String, dynamic>{})..remove('code'),
        _successEnvelope(<String, dynamic>{})..remove('data'),
        _successEnvelope(<String, dynamic>{})..remove('meta'),
        _successEnvelope(<String, dynamic>{})
          ..['meta'] = <String, dynamic>{'requestId': _requestId},
        _successEnvelope(<String, dynamic>{})
          ..['meta'] = <String, dynamic>{
            'requestId': '',
            'timestamp': _timestamp,
          },
      ];

      for (final envelope in invalidEnvelopes) {
        final failure = _decodeFailure(decoder, 200, envelope);
        expect(failure.code, 'INVALID_RESPONSE');
        expect(failure.status, 200);
      }
    });

    test(
      'rejects wrong envelope field types and invalid structured fields',
      () {
        final invalidEnvelopes = <Map<String, dynamic>>[
          _successEnvelope(<String, dynamic>{})..['success'] = 'true',
          _successEnvelope(<String, dynamic>{})..['code'] = 5,
          _successEnvelope(<String, dynamic>{})..['message'] = <String>[],
          _successEnvelope(<String, dynamic>{})
            ..['meta'] = <String, dynamic>{
              'requestId': _requestId,
              'timestamp': 42,
            },
          _successEnvelope(<String, dynamic>{})
            ..['meta'] = <String, dynamic>{
              'requestId': _requestId,
              'timestamp': _timestamp,
              'pagination': <dynamic>[],
            },
        ];
        for (final envelope in invalidEnvelopes) {
          expect(
            _decodeFailure(decoder, 200, envelope).code,
            'INVALID_RESPONSE',
          );
        }
      },
    );

    test('rejects malformed field-level errors without losing status', () {
      final envelope = _errorEnvelope(
        'VALIDATION_FAILED',
        'Invalid.',
        errors: const <dynamic>[
          <String, dynamic>{'field': 7, 'code': 'INVALID', 'message': 'No.'},
        ],
      );
      final failure = _decodeFailure(decoder, 422, envelope);

      expect(failure.status, 422);
      expect(failure.code, 'INVALID_RESPONSE');
      expect(failure.message, 'The server returned an invalid response.');
    });

    test('rejects contradictory HTTP and application outcomes', () {
      final successOnError = _successEnvelope(<String, dynamic>{});
      final errorOnSuccess = _errorEnvelope('CONFLICT', 'Conflict.');

      expect(
        _decodeFailure(decoder, 409, successOnError).code,
        'INVALID_RESPONSE',
      );
      expect(
        _decodeFailure(decoder, 200, errorOnSuccess).code,
        'INVALID_RESPONSE',
      );
    });

    test('rejects invalid error data, success errors, and bodyless 204', () {
      final nonNullErrorData = _errorEnvelope('CONFLICT', 'Conflict.')
        ..['data'] = <String, dynamic>{};
      final successWithErrors = _successEnvelope(<String, dynamic>{})
        ..['errors'] = const <dynamic>[
          <String, dynamic>{
            'field': 'title',
            'code': 'REQUIRED',
            'message': 'Title required.',
          },
        ];

      expect(
        _decodeFailure(decoder, 409, nonNullErrorData).code,
        'INVALID_RESPONSE',
      );
      expect(
        _decodeFailure(decoder, 200, successWithErrors).code,
        'INVALID_RESPONSE',
      );
      expect(_decodeFailure(decoder, 204, <String, dynamic>{}).status, 204);
    });

    test('rejects a non-object top-level JSON value', () {
      final failure = _decodeFailure(decoder, 200, <dynamic>[]);
      expect(failure.code, 'INVALID_RESPONSE');
    });
  });
}

final _invalidPayload = isA<ApiFailure>()
    .having((failure) => failure.code, 'code', 'INVALID_RESPONSE')
    .having((failure) => failure.status, 'status', 200)
    .having((failure) => failure.requestId, 'requestId', _requestId)
    .having((failure) => failure.timestamp, 'timestamp', _timestamp)
    .having(
      (failure) => failure.isTransportFailure,
      'transport failure',
      isFalse,
    );

ApiResult _decode(
  ApiResponseDecoder decoder,
  int statusCode,
  dynamic data, {
  Map<String, String> headers = const <String, String>{},
  Map<String, dynamic> meta = const <String, dynamic>{
    'requestId': _requestId,
    'timestamp': _timestamp,
  },
  Map<String, dynamic> extraEnvelope = const <String, dynamic>{},
}) {
  final envelope = _successEnvelope(data, meta: meta)..addAll(extraEnvelope);
  return decoder.decode(
    statusCode: statusCode,
    headers: headers,
    bodyBytes: utf8.encode(jsonEncode(envelope)),
  );
}

ApiFailure _decodeFailure(
  ApiResponseDecoder decoder,
  int statusCode,
  Object body, {
  Map<String, String> headers = const <String, String>{},
}) {
  final bytes = body is List<int> ? body : utf8.encode(jsonEncode(body));
  try {
    decoder.decode(statusCode: statusCode, headers: headers, bodyBytes: bytes);
  } on ApiFailure catch (failure) {
    return failure;
  }
  throw StateError('Expected ApiResponseDecoder to reject this response.');
}

Map<String, dynamic> _successEnvelope(
  dynamic data, {
  Map<String, dynamic> meta = const <String, dynamic>{
    'requestId': _requestId,
    'timestamp': _timestamp,
  },
}) => <String, dynamic>{
  'success': true,
  'code': 'SUCCESS',
  'message': 'Completed.',
  'data': data,
  'meta': meta,
};

Map<String, dynamic> _errorEnvelope(
  String code,
  String message, {
  List<dynamic>? errors,
}) => <String, dynamic>{
  'success': false,
  'code': code,
  if (message.isNotEmpty) 'message': message,
  'data': null,
  'meta': const <String, dynamic>{
    'requestId': _requestId,
    'timestamp': _timestamp,
  },
  if (errors != null) 'errors': errors,
};
