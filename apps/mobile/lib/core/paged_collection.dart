import 'api_client.dart';
import 'api_model_validation.dart';

/// A decoded server page. This is intentionally distinct from ordinary lists,
/// which do not require pagination metadata.
class PagedCollection<T> {
  const PagedCollection({
    required this.items,
    required this.page,
    required this.size,
    required this.totalElements,
    required this.totalPages,
    required this.hasNext,
    required this.hasPrevious,
  });

  final List<T> items;
  final int page;
  final int size;
  final int totalElements;
  final int totalPages;
  final bool hasNext;
  final bool hasPrevious;

  factory PagedCollection.fromResult(
    ApiResult response,
    T Function(Map<String, dynamic>) decode, {
    required int requestedPage,
    required int requestedSize,
  }) {
    if (requestedPage < 0 || requestedSize < 1) {
      throw ArgumentError(
        'Requested page must be nonnegative and size positive.',
      );
    }
    if (!response.meta.containsKey('pagination')) {
      invalidApiData(response: response);
    }
    final pagination = requireJsonObject(
      response.meta['pagination'],
      response: response,
    );
    final page = requiredInt(pagination, 'page', response: response);
    final size = requiredInt(
      pagination,
      'size',
      response: response,
      minimum: 1,
    );
    final totalElements = requiredInt(
      pagination,
      'totalElements',
      response: response,
    );
    final totalPages = requiredInt(
      pagination,
      'totalPages',
      response: response,
    );
    final hasNext = requiredBool(pagination, 'hasNext', response: response);
    final hasPrevious = requiredBool(
      pagination,
      'hasPrevious',
      response: response,
    );

    final expectedTotalPages = totalElements == 0
        ? 0
        : (totalElements + size - 1) ~/ size;
    if (page != requestedPage ||
        size != requestedSize ||
        totalPages != expectedTotalPages ||
        hasPrevious != (page > 0) ||
        hasNext != (page + 1 < totalPages)) {
      invalidApiData(response: response);
    }

    final rawItems = response.objectArrayData();
    if (rawItems.length > size) invalidApiData(response: response);
    final items = <T>[];
    for (final raw in rawItems) {
      try {
        items.add(decode(raw));
      } on ApiFailure {
        rethrow;
      } on TypeError {
        invalidApiData(response: response);
      } on FormatException {
        invalidApiData(response: response);
      }
    }

    return PagedCollection(
      items: List.unmodifiable(items),
      page: page,
      size: size,
      totalElements: totalElements,
      totalPages: totalPages,
      hasNext: hasNext,
      hasPrevious: hasPrevious,
    );
  }
}

/// A request token fences page responses to the collection generation and
/// expected page from which the request was made.
class PageRequestToken {
  const PageRequestToken._(this._owner, this.generation, this.page);

  final Object _owner;
  final int generation;
  final int page;
}

/// Explicit in-memory page accumulation for a single active query generation.
class PageWindow<T> {
  final List<T> _items = [];
  final Object _owner = Object();

  int _generation = 0;
  int nextPage = 0;
  int? currentPage;
  int? totalElements;
  int? totalPages;
  bool? hasPrevious;
  bool hasMore = true;

  List<T> get items => List.unmodifiable(_items);
  int get generation => _generation;

  PageRequestToken beginRequest() {
    if (!hasMore) throw StateError('The collection is already complete.');
    return PageRequestToken._(_owner, _generation, nextPage);
  }

  void reset() {
    _items.clear();
    _generation++;
    nextPage = 0;
    currentPage = null;
    totalElements = null;
    totalPages = null;
    hasPrevious = null;
    hasMore = true;
  }

  /// Returns false for a response from an earlier reset generation. Duplicate
  /// and out-of-order results fail without changing accumulated data.
  bool accept(PagedCollection<T> page, {required PageRequestToken request}) {
    if (!identical(request._owner, _owner)) {
      throw StateError('Page request belongs to a different collection.');
    }
    if (request.generation != _generation) return false;
    if (!hasMore || request.page != nextPage || page.page != nextPage) {
      throw StateError('Page sequence changed. Refresh the list.');
    }

    _items.addAll(page.items);
    currentPage = page.page;
    nextPage = page.page + 1;
    totalElements = page.totalElements;
    totalPages = page.totalPages;
    hasPrevious = page.hasPrevious;
    hasMore = page.hasNext;
    return true;
  }
}
