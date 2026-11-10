import 'api_client.dart';

/// Decode page metadata from the authorized Core API response.
class PagedCollection<T> {
  const PagedCollection({
    required this.items,
    required this.page,
    required this.hasNext,
    required this.totalElements,
  });
  final List<T> items;
  final int page;
  final bool hasNext;
  final int? totalElements;

  factory PagedCollection.fromResult(
      ApiResult response, T Function(Map<String, dynamic>) decode) {
    final pagination = objectOf(response.meta['pagination']);
    return PagedCollection(
      items: objectsOf(response.data).map(decode).toList(growable: false),
      page: (pagination['page'] as num?)?.toInt() ?? 0,
      hasNext: pagination['hasNext'] == true,
      totalElements: (pagination['totalElements'] as num?)?.toInt(),
    );
  }
}

/// Never infer the existence of the next page from the number of visible rows.
class PageWindow<T> {
  final List<T> _items = [];
  int nextPage = 0;
  bool hasMore = true;
  List<T> get items => List.unmodifiable(_items);

  void reset() {
    _items.clear();
    nextPage = 0;
    hasMore = true;
  }

  void accept(PagedCollection<T> page) {
    if (page.page != nextPage) {
      throw StateError('Page sequence changed. Refresh the list.');
    }
    _items.addAll(page.items);
    hasMore = page.hasNext;
    nextPage++;
  }
}
