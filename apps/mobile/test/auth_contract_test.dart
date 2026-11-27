import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

void main() {
  group('mobile token response contract', () {
    test('parses the complete Core API token response', () {
      final tokens = AuthTokenResponse.fromJson(
        _tokenResponse(),
        response: _apiResult(_tokenResponse()),
      );

      expect(tokens.accessToken, 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln');
      expect(tokens.refreshToken, 'refresh-token');
      expect(tokens.tokenType, AuthTokenType.bearer);
      expect(tokens.expiresIn, 600);
    });

    test(
      'rejects missing tokens, unsupported token types, and invalid expiry',
      () {
        final invalidResponses = <Map<String, dynamic>>[
          <String, dynamic>{..._tokenResponse()}..remove('accessToken'),
          <String, dynamic>{..._tokenResponse(), 'refreshToken': ''},
          <String, dynamic>{..._tokenResponse(), 'accessToken': 'not-a-jwt'},
          <String, dynamic>{
            ..._tokenResponse(),
            'refreshToken': 'unsafe token',
          },
          <String, dynamic>{..._tokenResponse(), 'tokenType': 'MAC'},
          <String, dynamic>{..._tokenResponse(), 'expiresIn': 0},
          <String, dynamic>{..._tokenResponse(), 'expiresIn': -1},
          <String, dynamic>{..._tokenResponse(), 'expiresIn': 600.5},
          <String, dynamic>{..._tokenResponse()}..remove('expiresIn'),
        ];

        for (final invalid in invalidResponses) {
          expect(
            () => AuthTokenResponse.fromJson(
              invalid,
              response: _apiResult(invalid),
            ),
            throwsA(
              isA<ApiFailure>()
                  .having(
                    (failure) => failure.invalidResponse,
                    'invalid',
                    isTrue,
                  )
                  .having(
                    (failure) => failure.requestId,
                    'requestId',
                    'auth-response-id',
                  ),
            ),
          );
        }
      },
    );
  });

  group('current identity contract', () {
    test('parses required fields and supported nullable context', () {
      final identity = AuthIdentity.fromJson(
        _identity(),
        response: _apiResult(_identity()),
      );

      expect(identity.userId.value, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(identity.primaryOrgUnitId, isNull);
      expect(identity.directoryManagementScope.allUnits, isFalse);
      expect(identity.directoryManagementScope.unitIds, isEmpty);
      expect(identity.session.lastSeenAt, isNull);
      expect(identity.session.clientType, AuthClientType.mobile);
      expect(identity.isEligibleMobileIdentity, isTrue);
      expect(identity.globalRole, AuthGlobalRole.employee);
      expect(identity.accountStatus, AuthAccountStatus.active);
    });

    test(
      'rejects missing fields, malformed identifiers, enums, and timestamps',
      () {
        final missingFields = <Map<String, dynamic>>[
          for (final field in <String>[
            'userId',
            'email',
            'displayName',
            'globalRole',
            'accountStatus',
            'primaryOrgUnitId',
            'directoryManagementScope',
            'session',
          ])
            _identity()..remove(field),
        ];
        final invalidUserId = <String, dynamic>{
          ..._identity(),
          'userId': 'not-a-uuid',
        };
        final invalidUnitId = <String, dynamic>{
          ..._identity(),
          'primaryOrgUnitId': 'not-a-uuid',
        };
        final invalidTimestamp = <String, dynamic>{
          ..._identity(),
          'session': <String, dynamic>{
            ..._identity()['session'] as Map<String, dynamic>,
            'createdAt': 'not-a-timestamp',
          },
        };
        final invalidScope = <String, dynamic>{
          ..._identity(),
          'directoryManagementScope': <String, dynamic>{
            'allUnits': false,
            'unitIds': <String>['invalid'],
          },
        };
        final invalidStatus = <String, dynamic>{
          ..._identity(),
          'accountStatus': 'UNKNOWN',
        };
        final invalidClientType = <String, dynamic>{
          ..._identity(),
          'session': <String, dynamic>{
            ..._identity()['session'] as Map<String, dynamic>,
            'clientType': 'NATIVE',
          },
        };
        final invalidSessionOrder = <String, dynamic>{
          ..._identity(),
          'session': <String, dynamic>{
            ..._identity()['session'] as Map<String, dynamic>,
            'absoluteExpiresAt': '2026-11-22T10:00:00Z',
          },
        };

        for (final invalid in <Map<String, dynamic>>[
          ...missingFields,
          invalidUserId,
          invalidUnitId,
          invalidTimestamp,
          invalidScope,
          invalidStatus,
          invalidClientType,
          invalidSessionOrder,
        ]) {
          expect(
            () => AuthIdentity.fromJson(invalid, response: _apiResult(invalid)),
            throwsA(
              isA<ApiFailure>().having(
                (failure) => failure.invalidResponse,
                'invalid',
                isTrue,
              ),
            ),
          );
        }
      },
    );

    test(
      'supports genuinely nullable values but parses non-mobile contexts',
      () {
        final identityJson = <String, dynamic>{
          ..._identity(),
          'primaryOrgUnitId': null,
          'session': <String, dynamic>{
            ..._identity()['session'] as Map<String, dynamic>,
            'clientType': 'WEB',
            'lastSeenAt': '2026-11-23T11:00:00+00:00',
          },
        };
        final identity = AuthIdentity.fromJson(
          identityJson,
          response: _apiResult(identityJson),
        );

        expect(identity.session.lastSeenAt, DateTime.utc(2026, 11, 23, 11));
        expect(identity.isEligibleMobileIdentity, isFalse);
      },
    );
  });

  test(
    'classifies auth errors by endpoint and preserves structured metadata',
    () {
      const classifier = AuthFailureClassifier();
      const loginRejection = ApiFailure(
        401,
        'AUTH_REQUIRED',
        'Sign-in was rejected.',
        requestId: 'login-request-id',
      );
      const refreshRejection = ApiFailure(
        401,
        'AUTH_SESSION_EXPIRED',
        'Session expired.',
        requestId: 'refresh-request-id',
      );
      const forbidden = ApiFailure(403, 'AUTHZ_FORBIDDEN', 'Forbidden.');
      const rateLimited = ApiFailure(
        429,
        'AUTH_RATE_LIMITED',
        'Try later.',
        requestId: 'rate-request-id',
        retryAfter: '45',
      );
      const malformed = ApiFailure(
        401,
        ApiFailure.invalidResponseCode,
        'Malformed response.',
      );
      const network = ApiFailure(
        0,
        'NETWORK_UNAVAILABLE',
        'Cannot reach server.',
        isTransportFailure: true,
      );
      const timeout = ApiFailure(
        0,
        'NETWORK_TIMEOUT',
        'The request timed out.',
        isTransportFailure: true,
      );
      const temporaryBackend = ApiFailure(
        503,
        'SERVICE_UNAVAILABLE',
        'Try again later.',
      );

      expect(
        classifier.classify(loginRejection, AuthEndpoint.login),
        AuthFailureCategory.authenticationRejected,
      );
      expect(
        classifier.classify(refreshRejection, AuthEndpoint.refresh),
        AuthFailureCategory.sessionInvalidated,
      );
      expect(
        classifier.classify(forbidden, AuthEndpoint.identity),
        AuthFailureCategory.authorizationDenied,
      );
      expect(
        classifier.classify(rateLimited, AuthEndpoint.refresh),
        AuthFailureCategory.rateLimited,
      );
      expect(
        classifier.classify(malformed, AuthEndpoint.refresh),
        AuthFailureCategory.invalidResponse,
      );
      expect(
        classifier.classify(network, AuthEndpoint.refresh),
        AuthFailureCategory.networkFailure,
      );
      expect(
        classifier.classify(timeout, AuthEndpoint.refresh),
        AuthFailureCategory.requestTimeout,
      );
      expect(
        classifier.classify(temporaryBackend, AuthEndpoint.refresh),
        AuthFailureCategory.temporaryServiceFailure,
      );
      expect(rateLimited.requestId, 'rate-request-id');
      expect(rateLimited.retryAfter, '45');
    },
  );
}

Map<String, dynamic> _tokenResponse() => <String, dynamic>{
  'accessToken': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
  'refreshToken': 'refresh-token',
  'tokenType': 'Bearer',
  'expiresIn': 600,
};

Map<String, dynamic> _identity() => <String, dynamic>{
  'userId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'email': 'user@example.test',
  'displayName': 'Test User',
  'globalRole': 'EMPLOYEE',
  'accountStatus': 'ACTIVE',
  'primaryOrgUnitId': null,
  'directoryManagementScope': <String, dynamic>{
    'allUnits': false,
    'unitIds': <String>[],
  },
  'session': <String, dynamic>{
    'id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'clientType': 'MOBILE',
    'createdAt': '2026-11-22T10:00:00Z',
    'lastSeenAt': null,
    'absoluteExpiresAt': '2026-12-22T10:00:00Z',
  },
};

ApiResult _apiResult(dynamic data) => ApiResult(
  data,
  const <String, dynamic>{},
  null,
  requestId: 'auth-response-id',
);
