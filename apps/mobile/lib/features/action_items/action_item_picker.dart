import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';

typedef ActionItemPickerLoader<T> =
    Future<PagedCollection<T>> Function(String search, int page);

class ActionItemPickerOption<T> {
  const ActionItemPickerOption({
    required this.value,
    required this.id,
    required this.label,
    this.subtitle,
  });

  final T value;
  final String id;
  final String label;
  final String? subtitle;
}

/// A feature-local single-selection surface. Its loader remains responsible
/// for using the correct authorized directory and captured session.
class ActionItemPicker<T> extends StatefulWidget {
  const ActionItemPicker({
    super.key,
    required this.api,
    required this.scope,
    required this.title,
    required this.load,
    required this.describe,
    this.minimumSearchLength = 0,
    this.pinned = const [],
  });

  final ApiClient api;
  final AuthenticatedSessionScope scope;
  final String title;
  final ActionItemPickerLoader<T> load;
  final ActionItemPickerOption<T> Function(T value) describe;
  final int minimumSearchLength;
  final List<ActionItemPickerOption<T>> pinned;

  @override
  State<ActionItemPicker<T>> createState() => _ActionItemPickerState<T>();
}

class _ActionItemPickerState<T> extends State<ActionItemPicker<T>> {
  final _search = TextEditingController();
  PageWindow<T> _window = PageWindow<T>();
  int _generation = 0;
  bool _busy = false;
  bool _loaded = false;
  bool _changed = false;
  bool _sessionLost = false;
  bool _accessDenied = false;
  Object? _error;
  Timer? _timer;

  bool get _current =>
      mounted &&
      !_sessionLost &&
      widget.api.isCurrentAuthenticatedSession(widget.scope);
  bool get _searchable =>
      _search.text.trim().length >= widget.minimumSearchLength;

  @override
  void initState() {
    super.initState();
    widget.api.sessionCoordinator.addListener(_sessionChanged);
    if (_searchable) unawaited(_fetch());
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    widget.api.sessionCoordinator.removeListener(_sessionChanged);
    _search.dispose();
    super.dispose();
  }

  void _sessionChanged() {
    if (!mounted || _sessionLost || _current) return;
    _timer?.cancel();
    _generation++;
    _search.clear();
    setState(() {
      _sessionLost = true;
      _window = PageWindow<T>();
      _error = null;
      _busy = false;
      _loaded = false;
    });
  }

  void _reset({required bool debounce}) {
    if (!_current) return;
    _timer?.cancel();
    setState(() {
      _generation++;
      _window = PageWindow<T>();
      _busy = false;
      _loaded = false;
      _changed = false;
      _accessDenied = false;
      _error = null;
    });
    if (!_searchable) return;
    if (debounce) {
      _timer = Timer(const Duration(milliseconds: 300), () {
        _timer = null;
        unawaited(_fetch());
      });
    } else {
      _timer = null;
      unawaited(_fetch());
    }
  }

  Future<void> _fetch() async {
    if (!_current || _busy || !_searchable || !_window.hasMore || _changed) {
      return;
    }
    final generation = _generation;
    final window = _window;
    final token = window.beginRequest();
    final query = _search.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final page = await widget.load(query, token.page);
      if (!_current || generation != _generation) return;
      final ids = window.items.map((value) {
        return widget.describe(value).id.toLowerCase();
      }).toSet();
      final duplicate = page.items.any(
        (value) => !ids.add(widget.describe(value).id.toLowerCase()),
      );
      final remaining = page.totalElements - page.page * page.size;
      final expected = remaining <= 0
          ? 0
          : remaining < page.size
          ? remaining
          : page.size;
      final changed =
          duplicate ||
          page.items.length != expected ||
          (window.totalElements != null &&
              window.totalElements != page.totalElements) ||
          (window.totalPages != null && window.totalPages != page.totalPages);
      setState(() {
        if (changed) {
          _changed = true;
          return;
        }
        if (window.accept(
          page,
          request: token,
          identity: (value) => widget.describe(value).id.toLowerCase(),
        )) {
          _loaded = true;
        }
      });
    } catch (error) {
      if (!_current || generation != _generation) return;
      setState(() {
        _error = error;
        if (error is ApiFailure &&
            (error.status == 401 || error.status == 403 || error.status == 404)) {
          _window = PageWindow<T>();
          _loaded = false;
          _accessDenied = true;
        }
      });
    } finally {
      if (_current && generation == _generation) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_current) {
      return Scaffold(
        appBar: AppBar(title: Text(widget.title)),
        body: const MessagePanel(title: 'Phiên đăng nhập đã thay đổi'),
      );
    }
    final pinnedIds = widget.pinned.map((option) => option.id.toLowerCase()).toSet();
    final options = [
      if (!_accessDenied) ...widget.pinned,
      ..._window.items.map(widget.describe).where(
        (option) => !pinnedIds.contains(option.id.toLowerCase()),
      ),
    ];
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: TextField(
                controller: _search,
                maxLength: 200,
                inputFormatters: [
                  TextInputFormatter.withFunction(
                    (old, next) => next.text.length > 200 ? old : next,
                  ),
                ],
                onChanged: (_) => _reset(debounce: true),
                onSubmitted: (_) => _reset(debounce: false),
                decoration: InputDecoration(
                  hintText: 'Tìm kiếm',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: IconButton(
                    tooltip: 'Xóa tìm kiếm',
                    onPressed: () {
                      _search.clear();
                      _reset(debounce: false);
                    },
                    icon: const Icon(Icons.close),
                  ),
                ),
              ),
            ),
            if (_busy) const LinearProgressIndicator(),
            Expanded(
              child: ListView.builder(
                keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: options.length + 1,
                itemBuilder: (context, index) {
                  if (index < options.length) {
                    final option = options[index];
                    return ListTile(
                      title: Text(option.label),
                      subtitle: option.subtitle == null
                          ? null
                          : Text(option.subtitle!),
                      onTap: () {
                        if (_current) Navigator.pop(context, option.value);
                      },
                    );
                  }
                  if (_error != null || _changed) {
                    return MessagePanel(
                      title: _changed
                          ? 'Danh sách đã thay đổi'
                          : 'Không thể tải danh sách',
                      description: 'Vui lòng thử lại.',
                      onRetry: _busy
                          ? null
                          : _changed
                          ? () => _reset(debounce: false)
                          : _fetch,
                    );
                  }
                  if (!_searchable) {
                    return const MessagePanel(
                      title: 'Nhập ít nhất 2 ký tự để tìm thành viên',
                    );
                  }
                  if (_loaded && _window.items.isEmpty && options.isEmpty) {
                    return const MessagePanel(title: 'Không có kết quả phù hợp');
                  }
                  if (_loaded && _window.hasMore) {
                    return OutlinedButton(
                      onPressed: _busy ? null : _fetch,
                      child: const Text('Tải thêm'),
                    );
                  }
                  return const SizedBox(height: 16);
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<T?> openActionItemPicker<T>(
  BuildContext context,
  ActionItemPicker<T> picker,
) => Navigator.push<T>(
  context,
  MaterialPageRoute<T>(builder: (_) => picker),
);

PagedCollection<R> mapActionItemPickerPage<T, R>(
  PagedCollection<T> page,
  R Function(T) map,
) => PagedCollection<R>(
  items: List<R>.unmodifiable(page.items.map(map)),
  page: page.page,
  size: page.size,
  totalElements: page.totalElements,
  totalPages: page.totalPages,
  hasNext: page.hasNext,
  hasPrevious: page.hasPrevious,
);
