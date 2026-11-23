import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/date_labels.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';

class TranscriptReviewPanel extends StatefulWidget {
  const TranscriptReviewPanel({
    super.key,
    required this.api,
    required this.meetingId,
  });
  final ApiClient api;
  final String meetingId;

  @override
  State<TranscriptReviewPanel> createState() => _TranscriptReviewPanelState();
}

class _TranscriptReviewPanelState extends State<TranscriptReviewPanel> {
  final search = TextEditingController();
  late Future<List<SpeechSegment>> future;
  @override
  void initState() {
    super.initState();
    reload();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  void reload() => setState(() {
    future = widget.api
        .get('/meetings/' + widget.meetingId + '/transcript')
        .then(speechSegments);
  });

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
        child: TextField(
          controller: search,
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.search),
            hintText: 'Tìm lời nói hoặc nhãn người nói',
          ),
          onChanged: (_) => setState(() {}),
        ),
      ),
      Expanded(
        child: AsyncContent<List<SpeechSegment>>(
          future: future,
          retry: reload,
          builder: (segments) {
            final query = search.text.trim().toLowerCase();
            final visible = segments
                .where(
                  (s) =>
                      s.text.toLowerCase().contains(query) ||
                      (s.speakerLabel ?? '').toLowerCase().contains(query),
                )
                .toList();
            return RefreshIndicator(
              onRefresh: () async {
                reload();
                await future;
              },
              child: ListView(
                padding: const EdgeInsets.all(18),
                children: [
                  SectionHeading(
                    'Transcript',
                    subtitle:
                        segments.length.toString() +
                        ' đoạn phát biểu có dấu thời gian',
                  ),
                  if (segments.isNotEmpty)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 12),
                      child: Text(
                        'Chỉnh sửa đoạn lời nói đang bị khóa vì API chỉ trả ETag của '
                        'toàn transcript, không trả ETag hiện hành cho từng đoạn.',
                        style: TextStyle(color: Palette.muted),
                      ),
                    ),
                  if (segments.isEmpty)
                    const MessagePanel(title: 'Transcript chưa sẵn sàng'),
                  if (segments.isNotEmpty && visible.isEmpty)
                    const MessagePanel(
                      title: 'Không tìm thấy nội dung phù hợp',
                    ),
                  ...visible.map(
                    (s) => ContentCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  s.speakerLabel ?? 'Chưa xác định',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                              Text(
                                durationLabel(s.startMs) +
                                    '–' +
                                    durationLabel(s.endMs),
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: Palette.muted,
                                ),
                              ),
                              const IconButton(
                                icon: Icon(Icons.edit_note_outlined),
                                onPressed: null,
                                tooltip: 'API chưa cung cấp ETag cho từng đoạn',
                              ),
                            ],
                          ),
                          SelectableText(s.text),
                          if (s.quality.isNotEmpty && s.quality != 'OK')
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: StatePill(s.quality),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    ],
  );
}
