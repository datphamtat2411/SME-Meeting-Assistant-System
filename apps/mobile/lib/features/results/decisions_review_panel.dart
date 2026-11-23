import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/meeting_models.dart';
import '../../core/paged_collection.dart';
import '../../core/widgets.dart';

class DecisionsReviewPanel extends StatefulWidget {
  const DecisionsReviewPanel({
    super.key,
    required this.api,
    required this.meetingId,
  });
  final ApiClient api;
  final String meetingId;
  @override
  State<DecisionsReviewPanel> createState() => _DecisionsReviewPanelState();
}

class _DecisionsReviewPanelState extends State<DecisionsReviewPanel> {
  late Future<List<MeetingDecision>> future;
  bool busy = false;
  @override
  void initState() {
    super.initState();
    reload();
  }

  void reload() => setState(() {
    future = widget.api
        .get(
          '/meetings/' + widget.meetingId + '/decisions',
          query: {'page': '0', 'size': '100'},
        )
        .then(
          (response) => PagedCollection<MeetingDecision>.fromResult(
            response,
            (raw) => MeetingDecision.fromJson(raw, response: response),
            requestedPage: 0,
            requestedSize: 100,
          ).items,
        );
  });

  Future<void> edit({MeetingDecision? decision}) async {
    if (decision != null) {
      if (mounted) showFailure(context, _missingDecisionEtag);
      return;
    }
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Tạo quyết định'),
        content: SizedBox(
          width: 480,
          child: TextField(
            controller: ctrl,
            minLines: 3,
            maxLines: 8,
            maxLength: 5000,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Lưu'),
          ),
        ],
      ),
    );
    final value = ctrl.text.trim();
    ctrl.dispose();
    if (ok != true || value.isEmpty || !mounted) return;
    setState(() => busy = true);
    try {
      final url = '/meetings/' + widget.meetingId + '/decisions';
      await widget.api.post(url, {'content': value, 'evidenceSegmentIds': []});
      if (mounted) {
        showSuccess(context, 'Đã lưu quyết định.');
        reload();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
        child: SectionHeading(
          'Quyết định',
          subtitle: 'Đề xuất AI cần xác nhận trước khi trở thành chính thức.',
          trailing: IconButton(
            onPressed: busy ? null : () => edit(),
            icon: const Icon(Icons.add_circle_outline),
          ),
        ),
      ),
      Expanded(
        child: AsyncContent<List<MeetingDecision>>(
          future: future,
          retry: reload,
          builder: (items) => RefreshIndicator(
            onRefresh: () async {
              reload();
              await future;
            },
            child: ListView(
              padding: const EdgeInsets.all(18),
              children: [
                if (items.isEmpty)
                  const MessagePanel(title: 'Chưa có quyết định'),
                ...items.map(
                  (d) => ContentCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            StatePill(d.status),
                            if (d.stale)
                              const Padding(
                                padding: EdgeInsets.only(left: 8),
                                child: StatePill(
                                  'COMPLETED_WITH_WARNINGS',
                                  label: 'Cần đối chiếu',
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 9),
                        SelectableText(d.content),
                        Wrap(
                          children: [
                            TextButton.icon(
                              onPressed: null,
                              icon: const Icon(Icons.edit_outlined),
                              label: const Text('Sửa'),
                            ),
                            if (d.status == 'PROPOSED') ...[
                              TextButton(
                                onPressed: null,
                                child: const Text('Xác nhận'),
                              ),
                              TextButton(
                                onPressed: null,
                                child: const Text(
                                  'Từ chối',
                                  style: TextStyle(color: Palette.red),
                                ),
                              ),
                            ],
                          ],
                        ),
                        const Text(
                          'API danh sách chưa cung cấp ETag cho từng quyết định; '
                          'các thay đổi bị khóa để tránh gửi phiên bản đoán.',
                          style: TextStyle(fontSize: 12, color: Palette.muted),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ],
  );
}

const _missingDecisionEtag = ApiFailure(
  0,
  'MISSING_ETAG',
  'Không thể thay đổi quyết định vì Core API chưa cung cấp ETag hiện hành.',
);
