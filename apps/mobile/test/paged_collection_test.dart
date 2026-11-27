import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';

void main() {
  group('PagedCollection', () {
    test('strictly decodes valid metadata and keeps item order', () {
      final page = _decode(
        _response(
          ['first', 'second'],
          page: 0,
          size: 2,
          totalElements: 3,
          totalPages: 2,
          hasNext: true,
          hasPrevious: false,
        ),
        requestedPage: 0,
        requestedSize: 2,
      );

      expect(page.items, ['first', 'second']);
      expect(page.page, 0);
      expect(page.size, 2);
      expect(page.totalElements, 3);
      expect(page.totalPages, 2);
      expect(page.hasNext, isTrue);
      expect(page.hasPrevious, isFalse);
    });

    test(
      'accepts valid empty collection and empty page beyond the last page',
      () {
        final empty = _decode(
          _response(
            [],
            page: 0,
            size: 20,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          ),
          requestedPage: 0,
          requestedSize: 20,
        );
        final beyond = _decode(
          _response(
            [],
            page: 4,
            size: 2,
            totalElements: 3,
            totalPages: 2,
            hasNext: false,
            hasPrevious: true,
          ),
          requestedPage: 4,
          requestedSize: 2,
        );

        expect(empty.items, isEmpty);
        expect(empty.hasNext, isFalse);
        expect(beyond.items, isEmpty);
        expect(beyond.hasPrevious, isTrue);
        expect(beyond.totalElements, 3);
      },
    );

    test('requires a metadata object with exact field types', () {
      for (final pagination in [
        null,
        <String, dynamic>{},
        {
          'page': 0,
          'size': 2.0,
          'totalElements': 1,
          'totalPages': 1,
          'hasNext': false,
          'hasPrevious': false,
        },
        {
          'page': '0',
          'size': 2,
          'totalElements': 1,
          'totalPages': 1,
          'hasNext': false,
          'hasPrevious': false,
        },
        {
          'page': 0,
          'size': 2,
          'totalElements': 1,
          'totalPages': 1,
          'hasNext': 0,
          'hasPrevious': false,
        },
      ]) {
        final response = ApiResult([], {
          if (pagination != null) 'pagination': pagination,
        }, null);
        expect(
          () => PagedCollection<String>.fromResult(
            response,
            (item) => item['id'] as String,
            requestedPage: 0,
            requestedSize: 2,
          ),
          throwsA(
            isA<ApiFailure>().having(
              (failure) => failure.invalidResponse,
              'invalidResponse',
              isTrue,
            ),
          ),
        );
      }
    });

    test('rejects inconsistent values, indicators, page and size', () {
      final invalidPages = [
        _pagination(page: -1),
        _pagination(size: 0),
        _pagination(totalElements: -1),
        _pagination(totalPages: -1),
        _pagination(totalPages: 2),
        _pagination(hasNext: true),
        _pagination(hasPrevious: true),
      ];

      for (final pagination in invalidPages) {
        expect(
          () => _decode(
            ApiResult([], {'pagination': pagination}, null),
            requestedPage: 0,
            requestedSize: 2,
          ),
          throwsA(isA<ApiFailure>()),
        );
      }
      expect(
        () => _decode(
          _response(
            [],
            page: 1,
            size: 2,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: true,
          ),
          requestedPage: 0,
          requestedSize: 2,
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(
        () => _decode(
          _response(
            [],
            page: 0,
            size: 3,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          ),
          requestedPage: 0,
          requestedSize: 2,
        ),
        throwsA(isA<ApiFailure>()),
      );
    });

    test('invalid pagination keeps HTTP and request correlation context', () {
      final response = ApiResult(
        [],
        {'pagination': _pagination(hasNext: true)},
        null,
        statusCode: 206,
        requestId: 'body-request',
        responseRequestId: 'header-request',
      );

      try {
        _decode(response, requestedPage: 0, requestedSize: 2);
        fail('Expected invalid pagination failure.');
      } on ApiFailure catch (failure) {
        expect(failure.invalidResponse, isTrue);
        expect(failure.status, 206);
        expect(failure.requestId, 'body-request');
        expect(failure.responseRequestId, 'header-request');
        expect(failure.transportFailure, isFalse);
      }
    });

    test('ordinary non-paginated API arrays remain valid', () {
      final result = ApiResult(
        [
          {'id': 'one'},
        ],
        const {},
        null,
      );

      expect(result.objectArrayData().single['id'], 'one');
    });
  });

  group('PageWindow', () {
    test(
      'appends accepted pages in order and stops at authoritative completion',
      () {
        final window = PageWindow<String>();
        final firstRequest = window.beginRequest();
        expect(
          window.accept(
            _decode(
              _response(
                ['one', 'two'],
                page: 0,
                size: 2,
                totalElements: 3,
                totalPages: 2,
                hasNext: true,
                hasPrevious: false,
              ),
              requestedPage: 0,
              requestedSize: 2,
            ),
            request: firstRequest,
          ),
          isTrue,
        );
        final secondRequest = window.beginRequest();
        window.accept(
          _decode(
            _response(
              ['three'],
              page: 1,
              size: 2,
              totalElements: 3,
              totalPages: 2,
              hasNext: false,
              hasPrevious: true,
            ),
            requestedPage: 1,
            requestedSize: 2,
          ),
          request: secondRequest,
        );

        expect(window.items, ['one', 'two', 'three']);
        expect(window.nextPage, 2);
        expect(window.hasMore, isFalse);
        expect(window.totalElements, 3);
        expect(window.totalPages, 2);
        expect(() => window.beginRequest(), throwsStateError);
      },
    );

    test('rejects duplicate and out-of-order pages without mutating items', () {
      final window = PageWindow<String>();
      final duplicateRequest = window.beginRequest();
      final first = _decode(
        _response(
          ['one'],
          page: 0,
          size: 2,
          totalElements: 3,
          totalPages: 2,
          hasNext: true,
          hasPrevious: false,
        ),
        requestedPage: 0,
        requestedSize: 2,
      );
      window.accept(first, request: duplicateRequest);
      expect(
        () => window.accept(first, request: duplicateRequest),
        throwsStateError,
      );
      expect(
        () => window.accept(
          _decode(
            _response(
              ['three'],
              page: 1,
              size: 2,
              totalElements: 3,
              totalPages: 2,
              hasNext: false,
              hasPrevious: true,
            ),
            requestedPage: 1,
            requestedSize: 2,
          ),
          request: duplicateRequest,
        ),
        throwsStateError,
      );
      expect(window.items, ['one']);
      expect(window.nextPage, 1);
    });

    test('does not deduplicate records supplied by the server', () {
      final window = PageWindow<String>();
      window.accept(
        _decode(
          _response(
            ['same', 'same'],
            page: 0,
            size: 2,
            totalElements: 2,
            totalPages: 1,
            hasNext: false,
            hasPrevious: false,
          ),
          requestedPage: 0,
          requestedSize: 2,
        ),
        request: window.beginRequest(),
      );

      expect(window.items, ['same', 'same']);
    });

    test('can deduplicate paged identities for history views', () {
      final window = PageWindow<String>();
      window.accept(
        _decode(
          _response(
            ['v1', 'v2'],
            page: 0,
            size: 2,
            totalElements: 3,
            totalPages: 2,
            hasNext: true,
            hasPrevious: false,
          ),
          requestedPage: 0,
          requestedSize: 2,
        ),
        request: window.beginRequest(),
        identity: (item) => item,
      );
      window.accept(
        _decode(
          _response(
            ['v2', 'v3'],
            page: 1,
            size: 2,
            totalElements: 3,
            totalPages: 2,
            hasNext: false,
            hasPrevious: true,
          ),
          requestedPage: 1,
          requestedSize: 2,
        ),
        request: window.beginRequest(),
        identity: (item) => item,
      );

      expect(window.items, ['v1', 'v2', 'v3']);
    });

    test(
      'reset invalidates in-flight page responses from the previous generation',
      () {
        final window = PageWindow<String>();
        final staleRequest = window.beginRequest();
        window.accept(
          _decode(
            _response(
              ['current'],
              page: 0,
              size: 2,
              totalElements: 1,
              totalPages: 1,
              hasNext: false,
              hasPrevious: false,
            ),
            requestedPage: 0,
            requestedSize: 2,
          ),
          request: window.beginRequest(),
        );
        window.reset();

        expect(
          window.accept(
            _decode(
              _response(
                ['stale'],
                page: 0,
                size: 2,
                totalElements: 1,
                totalPages: 1,
                hasNext: false,
                hasPrevious: false,
              ),
              requestedPage: 0,
              requestedSize: 2,
            ),
            request: staleRequest,
          ),
          isFalse,
        );
        expect(window.items, isEmpty);
        expect(window.nextPage, 0);
        expect(window.hasMore, isTrue);
        expect(window.totalElements, isNull);
      },
    );
  });
}

PagedCollection<String> _decode(
  ApiResult response, {
  required int requestedPage,
  required int requestedSize,
}) => PagedCollection<String>.fromResult(
  response,
  (item) => item['id'] as String,
  requestedPage: requestedPage,
  requestedSize: requestedSize,
);

ApiResult _response(
  List<String> ids, {
  required int page,
  required int size,
  required int totalElements,
  required int totalPages,
  required bool hasNext,
  required bool hasPrevious,
}) => ApiResult(ids.map((id) => {'id': id}).toList(), {
  'pagination': _pagination(
    page: page,
    size: size,
    totalElements: totalElements,
    totalPages: totalPages,
    hasNext: hasNext,
    hasPrevious: hasPrevious,
  ),
}, null);

Map<String, dynamic> _pagination({
  int page = 0,
  int size = 2,
  int totalElements = 0,
  int totalPages = 0,
  bool hasNext = false,
  bool hasPrevious = false,
}) => {
  'page': page,
  'size': size,
  'totalElements': totalElements,
  'totalPages': totalPages,
  'hasNext': hasNext,
  'hasPrevious': hasPrevious,
};
