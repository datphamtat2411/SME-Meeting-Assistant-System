import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'action_item_feed.dart';
import 'action_item_create_sheet.dart';
import 'action_item_detail_sheet.dart';

class ActionItemsPage extends StatefulWidget {
  const ActionItemsPage({super.key, required this.api});
  final ApiClient api;
  @override
  State<ActionItemsPage> createState() => _ActionItemsPageState();
}

class _ActionItemsPageState extends State<ActionItemsPage> {
  late final ActionItemFeed feed;
  late Future<List<ActionItem>> future;
  final search = TextEditingController();
  bool changing = false;

  @override
  void initState() {
    super.initState();
    feed = ActionItemFeed(widget.api);
    reload();
  }

  @override
  void dispose() { search.dispose(); super.dispose(); }

  void reload() => setState(() {
    feed.reset();
    future = feed.fetchNext();
  });

  void more() => setState(() => future = feed.fetchNext());

  Future<void> create() async {
    final saved = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, showDragHandle: true,
      builder: (_) => ActionItemCreateSheet(api: widget.api));
    if (saved == true && mounted) reload();
  }

  Future<void> edit(ActionItem item) async {
    final saved = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, showDragHandle: true,
      builder: (_) => ActionItemDetailSheet(api: widget.api, item: item));
    if (saved == true && mounted) reload();
  }

  Future<void> command(ActionItem item, String action) async {
    if (changing) return;
    if (action == 'cancel' || action == 'reject') {
      final agree = await confirmCommand(context,
        title: action == 'cancel' ? 'Hủy công việc?' : 'Từ chối đề xuất AI?',
        description: 'Máy chủ sẽ lưu lịch sử thay đổi trạng thái.',
        destructive: true);
      if (!agree || !mounted) return;
    }
    setState(() => changing = true);
    try {
      final path = '/action-items/' + item.id;
      final current = await widget.api.get(path);
      await widget.api.post(path + '/' + action, {},
        headers: {'If-Match': requireEtag(current)});
      if (mounted) { showSuccess(context, 'Đã cập nhật trạng thái.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => changing = false); }
  }

  Widget controls(ActionItem item) {
    final actions = switch (item.status) {
      'PROPOSED' => const [('confirm','Duyệt'), ('reject','Từ chối')],
      'OPEN' => const [('start','Bắt đầu'), ('cancel','Hủy')],
      'IN_PROGRESS' => const [('complete','Hoàn thành'), ('cancel','Hủy')],
      'DONE' => const [('reopen','Mở lại')],
      _ => const <(String,String)>[],
    };
    return Wrap(spacing: 4, children: actions.map((pair) =>
      TextButton(onPressed: changing ? null : () => command(item, pair.$1),
        child: Text(pair.$2))).toList());
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    Padding(padding: const EdgeInsets.fromLTRB(18, 16, 18, 6),
      child: Column(children: [
        SectionHeading('Công việc sau họp',
          subtitle: 'Công việc chính thức và đề xuất chờ xác nhận',
          trailing: IconButton(onPressed: create, icon: const Icon(Icons.add_circle_outline))),
        TextField(controller: search, onSubmitted: (_) {
          feed.query = search.text; reload();
        }, decoration: InputDecoration(
          hintText: 'Tìm công việc', prefixIcon: const Icon(Icons.search),
          suffixIcon: IconButton(onPressed: () {
            search.clear(); feed.query = ''; reload();
          }, icon: const Icon(Icons.close)))),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: DropdownButtonFormField<String>(
            key: ValueKey(feed.status), initialValue: feed.status ?? '',
            decoration: const InputDecoration(isDense: true, labelText: 'Trạng thái'),
            items: [
              const DropdownMenuItem(value: '', child: Text('Tất cả')),
              ...actionStates.entries.where((e) => e.key != 'REJECTED')
                .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value))),
            ],
            onChanged: (v) { feed.status = v == '' ? null : v; reload(); })),
          const SizedBox(width: 8),
          FilterChip(label: const Text('Của tôi'),
            selected: feed.mine, onSelected: (v) { feed.mine = v; reload(); }),
          const SizedBox(width: 4),
          IconButton(
            tooltip: 'Chỉ quá hạn',
            icon: Icon(feed.overdueOnly ? Icons.warning : Icons.warning_amber_outlined,
              color: feed.overdueOnly ? Palette.red : null),
            onPressed: () { feed.overdueOnly = !feed.overdueOnly; reload(); }),
        ]),
      ])),
    Expanded(child: AsyncContent<List<ActionItem>>(
      future: future, retry: reload,
      builder: (items) => RefreshIndicator(
        onRefresh: () async { reload(); await future; },
        child: ListView(padding: const EdgeInsets.all(18), children: [
          if (items.isEmpty) const MessagePanel(title: 'Không có đầu việc phù hợp',
            description: 'Đổi bộ lọc hoặc tạo công việc từ một cuộc họp.'),
          ...items.map((item) => ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              InkWell(onTap: () => edit(item),
                child: Row(children: [
                  Expanded(child: Text(item.title,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700))),
                  StatePill(item.status),
                  const Icon(Icons.chevron_right, size: 20),
                ])),
              if (item.details.isNotEmpty) Padding(
                padding: const EdgeInsets.only(top: 7),
                child: Text(item.details, maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Palette.muted))),
              const SizedBox(height: 10),
              Text(item.dueDate == null ? 'Chưa có hạn' : 'Hạn: ' + item.dueDate!,
                style: TextStyle(fontSize: 12,
                  color: item.overdue ? Palette.red : Palette.muted)),
              if (item.overdue) const StatePill('FAILED', label: 'Quá hạn'),
              controls(item),
            ]))),
          if (feed.window.hasMore) OutlinedButton.icon(
            onPressed: more, icon: const Icon(Icons.expand_more),
            label: const Text('Tải thêm công việc')),
        ]),
      )),
    )),
  ]);
}
