import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_presentation.dart';
import 'results_workspace_controller.dart';
import 'transcript_evidence_navigation.dart';

class MinutesPanel extends StatelessWidget {
  const MinutesPanel({super.key, required this.workspace, this.openActionItem});
  final ResultsWorkspaceController workspace;
  final Future<void> Function(BuildContext, String)? openActionItem;

  String _availability(String value) => switch (value) {
    'AVAILABLE' => 'Có dữ liệu',
    'NOT_AVAILABLE' => 'Chưa có dữ liệu',
    'PROCESSING' => 'Đang xử lý',
    'FAILED' => 'Xử lý thất bại',
    'NEEDS_REVIEW' => 'Cần đối chiếu',
    _ => 'Trạng thái chưa được hỗ trợ',
  };

  String _warning(String code) => switch (code) {
    'TRANSCRIPT_NOT_AVAILABLE' => 'Chưa có bản ghi lời thoại.',
    'TRANSCRIPT_PROCESSING' => 'Bản ghi lời thoại đang được xử lý.',
    'TRANSCRIPT_FAILED' => 'Xử lý bản ghi lời thoại thất bại.',
    'TRANSCRIPT_SUSPICIOUS_SEGMENTS' => 'Có đoạn lời thoại đáng ngờ.',
    'TRANSCRIPT_UNRESOLVED_SEGMENTS' => 'Có đoạn lời thoại chưa giải quyết.',
    'TRANSCRIPT_INCOMPLETE_COVERAGE' => 'Bằng chứng âm thanh chưa đầy đủ.',
    'TRANSCRIPT_QUALITY_WARNING' => 'Chất lượng lời thoại cần đối chiếu.',
    'SUMMARY_NOT_AVAILABLE' => 'Chưa có tóm tắt được chọn.',
    'SUMMARY_SOURCE_STALE' => 'Nguồn tóm tắt đã thay đổi.',
    'SUMMARY_QUALITY_WARNING' => 'Tóm tắt có cảnh báo chất lượng.',
    'DECISION_SOURCE_STALE' => 'Nguồn của quyết định đã thay đổi.',
    'DECISION_EVIDENCE_WARNING' => 'Bằng chứng quyết định cần đối chiếu.',
    _ => 'Cảnh báo từ máy chủ: $code',
  };

  String _source(String? source) => switch (source) {
    'AI' || 'AI_EXTRACTED' || 'AI_GENERATED' => 'Do AI tạo',
    'HUMAN_EDIT' => 'Đã chỉnh sửa bởi người dùng',
    'MANUAL' => 'Do người dùng tạo',
    _ => source ?? 'Không có thông tin nguồn',
  };

  Widget _card(List<Widget> children) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    ),
  );

  Widget _label(String name, Object? value) => Padding(
    padding: const EdgeInsets.only(top: 5),
    child: Text('$name: ${value ?? 'Chưa có thông tin'}'),
  );

  Widget _warnings(List<String> warnings) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final warning in warnings)
        Text(
          '• ${_warning(warning)}',
          style: const TextStyle(color: Palette.amber),
        ),
    ],
  );

  Future<void> _openEvidence(
    BuildContext context,
    MinutesDecision decision,
    String segmentId,
  ) async {
    final transcriptId = decision.transcriptId;
    final revision = decision.contentRevision;
    if (transcriptId == null || revision == null) return;
    final epoch = workspace.readEpoch;
    final result = await TranscriptEvidenceNavigationBoundary(workspace).locate(
      TranscriptEvidenceReference(
        transcriptId: transcriptId,
        segmentId: segmentId,
        contentRevision: revision,
      ),
    );
    if (!context.mounted || !workspace.ownsRead(epoch)) return;
    if (result.status != TranscriptEvidenceNavigationStatus.opened) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Không thể mở bằng chứng nguồn đã ghi.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: workspace,
    builder: (context, _) {
      final resource = workspace.minutes;
      final minutes = workspace.capabilities.canRead && resource.hasData
          ? resource.data
          : null;
      if (minutes == null) {
        return resultsResourceMessage(
          resource,
          label: 'Biên bản',
          onRetry: () => workspace.loadMinutes(force: true),
        );
      }
      final meeting = minutes.meeting;
      final summary = minutes.summary;
      final transcript = minutes.transcript;
      final decisions = minutes.confirmedDecisions;
      final actions = minutes.officialActionItems;
      return RefreshIndicator(
        onRefresh: () => workspace.loadMinutes(force: true),
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(18),
              sliver: SliverList.list(
                children: [
                  const SectionHeading('Biên bản cuộc họp'),
                  resultsRefreshNotice(
                    resource,
                    () => workspace.loadMinutes(force: true),
                  ),
                  _card([
                    StatePill(
                      minutes.completeness,
                      label: switch (minutes.completeness) {
                        'COMPLETE' => 'Đầy đủ',
                        'NEEDS_REVIEW' => 'Cần đối chiếu',
                        _ => 'Chưa đầy đủ',
                      },
                    ),
                    _label('Lập lúc', dateLabel(minutes.assembledAt)),
                    const Text('Tóm tắt AI không đồng nghĩa với phê duyệt.'),
                    const SizedBox(height: 8),
                    Text(
                      meeting.title,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    if (meeting.description != null)
                      SelectableText(meeting.description!),
                    StatePill(meeting.status),
                    _label(
                      'Người tổ chức',
                      workspace.meetingIdentityLabel(meeting.organizerUserId) ??
                          'Chưa rõ tên',
                    ),
                    _label(
                      'Bắt đầu dự kiến',
                      dateLabel(meeting.scheduledStartAt),
                    ),
                    _label(
                      'Kết thúc dự kiến',
                      dateLabel(meeting.scheduledEndAt),
                    ),
                    _label('Bắt đầu thực tế', dateLabel(meeting.startedAt)),
                    _label('Kết thúc thực tế', dateLabel(meeting.endedAt)),
                  ]),
                  const SectionHeading('Tóm tắt đã chọn'),
                  _card([
                    Text(_availability(summary.availability)),
                    if (summary.versionNumber != null)
                      _label('Phiên bản', summary.versionNumber),
                    if (summary.sourceType != null)
                      Text(_source(summary.sourceType)),
                    if (summary.qualityStatus != null)
                      StatePill(summary.qualityStatus!),
                    if (summary.contentRevision != null)
                      _label('Revision nguồn', summary.contentRevision),
                    if (summary.isStale)
                      const Text('Nguồn tóm tắt đã thay đổi.'),
                    if (summary.content != null)
                      SelectableText(summary.content!)
                    else
                      const Text('Chưa có bản tóm tắt phù hợp.'),
                    _warnings(summary.aiWarnings),
                  ]),
                  SectionHeading(
                    'Quyết định đã xác nhận',
                    subtitle: '${decisions.length} quyết định',
                  ),
                  if (decisions.isEmpty)
                    const MessagePanel(title: 'Chưa có quyết định chính thức'),
                ],
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              sliver: SliverList.builder(
                itemCount: decisions.length,
                itemBuilder: (context, index) {
                  final decision = decisions[index];
                  return _card([
                    StatePill(decision.status),
                    SelectableText(decision.content),
                    Text(_source(decision.sourceType)),
                    _label(
                      'Xác nhận bởi',
                      workspace.meetingIdentityLabel(
                            decision.confirmedByUserId,
                          ) ??
                          'Chưa rõ tên',
                    ),
                    _label(
                      'Thời điểm xác nhận',
                      dateLabel(decision.confirmedAt),
                    ),
                    if (decision.isStale)
                      const Text('Đã xác nhận; nguồn cần đối chiếu lại.'),
                    if (decision.aiUncertainty == 'MATERIAL')
                      const Text('Có bất định đáng kể về bằng chứng.'),
                    _warnings(decision.aiWarnings),
                    if (decision.transcriptId != null &&
                        decision.contentRevision != null)
                      for (
                        var i = 0;
                        i < decision.evidenceSegmentIds.length;
                        i++
                      )
                        TextButton(
                          onPressed: () => unawaited(
                            _openEvidence(
                              context,
                              decision,
                              decision.evidenceSegmentIds[i],
                            ),
                          ),
                          child: Text('Xem đoạn bằng chứng ${i + 1}'),
                        ),
                  ]);
                },
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.all(18),
              sliver: SliverList.list(
                children: [
                  SectionHeading(
                    'Đầu việc chính thức',
                    subtitle: '${actions.length} công việc',
                  ),
                  if (actions.isEmpty)
                    const MessagePanel(title: 'Chưa có đầu việc chính thức'),
                ],
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              sliver: SliverList.builder(
                itemCount: actions.length,
                itemBuilder: (context, index) {
                  final action = actions[index];
                  return _card([
                    Text(
                      action.title,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    if (action.details != null) SelectableText(action.details!),
                    StatePill(action.status),
                    Text(_source(action.sourceType)),
                    _label(
                      'Người phụ trách',
                      action.assigneeUserId == null
                          ? 'Chưa giao'
                          : minutes.assigneeDisplayNames[action
                                    .assigneeUserId] ??
                                workspace.meetingIdentityLabel(
                                  action.assigneeUserId,
                                ) ??
                                'Chưa rõ tên',
                    ),
                    _label('Hạn hoàn thành', action.dueDate),
                    _label(
                      'Xác nhận bởi',
                      workspace.meetingIdentityLabel(
                            action.confirmedByUserId,
                          ) ??
                          'Chưa rõ tên',
                    ),
                    _label('Thời điểm xác nhận', dateLabel(action.confirmedAt)),
                    if (openActionItem != null)
                      TextButton.icon(
                        onPressed: () =>
                            unawaited(openActionItem!(context, action.id)),
                        icon: const Icon(Icons.chevron_right),
                        label: const Text('Xem chi tiết công việc'),
                      ),
                  ]);
                },
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.all(18),
              sliver: SliverList.list(
                children: [
                  const SectionHeading('Tình trạng transcript'),
                  _card([
                    Text(_availability(transcript.availability)),
                    if (transcript.status != null)
                      StatePill(transcript.status!),
                    _label('Phiên bản', transcript.versionNumber),
                    _label('Revision', transcript.contentRevision),
                    _label('Ngôn ngữ', transcript.languageCode),
                    if (transcript.durationMs != null)
                      _label(
                        'Thời lượng',
                        '${transcript.durationMs! ~/ 1000} giây',
                      ),
                    _label('Đoạn đáng ngờ', transcript.suspiciousSegments),
                    _label(
                      'Đoạn chưa giải quyết',
                      transcript.unresolvedSegments,
                    ),
                    _label(
                      'Vùng thiếu bằng chứng',
                      transcript.unresolvedCoverageRegions,
                    ),
                  ]),
                  if (minutes.warnings.isNotEmpty) ...[
                    const SectionHeading('Cảnh báo và giới hạn nguồn'),
                    _card([_warnings(minutes.warnings)]),
                  ],
                ],
              ),
            ),
          ],
        ),
      );
    },
  );
}
