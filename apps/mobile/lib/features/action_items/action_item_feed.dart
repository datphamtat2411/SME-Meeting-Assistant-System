import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/paged_collection.dart';

class ActionItemFeed {
  ActionItemFeed(this.api);
  final ApiClient api;
  final PageWindow<ActionItem> window = PageWindow<ActionItem>();
  String? status;
  bool mine = true;
  String query = '';
  bool overdueOnly = false;

  void reset() => window.reset();

  Future<List<ActionItem>> fetchNext() async {
    if (!window.hasMore) return window.items;
    final request = window.beginRequest();
    final response = await api.get(
      '/action-items',
      query: {
        'page': request.page.toString(),
        'size': '20',
        'sort': 'createdAt,desc',
        if (status != null) 'status': status!,
        if (mine) 'assignee': 'me',
        if (query.trim().isNotEmpty) 'q': query.trim(),
        if (overdueOnly) 'overdue': 'true',
      },
    );
    final page = PagedCollection<ActionItem>.fromResult(
      response,
      (raw) => ActionItem.fromJson(raw, response: response),
      requestedPage: request.page,
      requestedSize: 20,
    );
    window.accept(page, request: request);
    return window.items;
  }
}
