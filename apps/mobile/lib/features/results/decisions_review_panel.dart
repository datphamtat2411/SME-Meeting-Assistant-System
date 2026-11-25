import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/meeting_models.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'decision_review_state.dart';
import 'results_workspace_controller.dart';
import 'transcript_evidence_navigation.dart';
import 'results_presentation.dart';
import 'results_models.dart';

class DecisionsReviewPanel extends StatefulWidget {
  const DecisionsReviewPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<DecisionsReviewPanel> createState() => _DecisionsReviewPanelState();
}

class _DecisionsReviewPanelState extends State<DecisionsReviewPanel> {
  bool busy = false;

  Future<void> createDecision() async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await _createDecision();
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> recoverUnknownDecision() async {
    final workspace = widget.workspace;
    final epoch = workspace.reviewEpoch;
    final intent = workspace.unresolvedDecision;
    if (intent == null || busy) return;
    setState(() => busy = true);
    try {
      List<MeetingDecision>? recovery;
      final reviewed = await runCommand(
        context,
        operation: () async {
          recovery = await workspace.reconcileUnknownDecision(epoch: epoch);
          if (recovery == null) {
            throw const ApiFailure(
              409,
              'RESULTS_OUTCOME_UNKNOWN',
              'Danh sách đã thay đổi hoặc không thể tải đầy đủ. Hãy thử lại.',
            );
          }
        },
        successText: 'Đã tải danh sách quyết định để kiểm tra.',
      );
      if (!reviewed || !mounted || !workspace.ownsReview(epoch)) return;
      final decisions = recovery!;
      final target = intent.snapshot;
      final observed = target == null
          ? decisions
          : decisions.where((item) => item.id == target.id).toList();
      final confirmed = await showResultsReviewDialog<bool>(
        context: context,
        workspace: workspace,
        epoch: epoch,
        builder: (dialog) => AlertDialog(
          title: const Text('Kiểm tra quyết định trước đó'),
          content: SizedBox(
            width: 480,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Yêu cầu trước có thể đã được lưu. Danh sách này không '
                    'chứng minh yêu cầu thành công hay thất bại. Hãy kiểm tra '
                    'trước khi tạo một yêu cầu mới.',
                  ),
                  if (target != null) ...[
                    Text('Thao tác trước: ${_commandLabel(intent.command)}'),
                    SelectableText(intent.content),
                    const Divider(),
                  ],
                  if (observed.isEmpty)
                    const Text(
                      'Không tìm thấy quyết định trong kết quả kiểm tra.',
                    ),
                  for (final decision in observed)
                    ListTile(
                      title: Text(decision.content),
                      subtitle: Text(decision.status),
                      contentPadding: EdgeInsets.zero,
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog, false),
              child: const Text('Quay lại'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialog, true),
              child: const Text('Đã kiểm tra, cho phép thao tác mới'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted || !workspace.ownsReview(epoch)) {
        return;
      }
      await runCommand(
        context,
        operation: () async {
          workspace.acknowledgeUnknownDecision(
            epoch: epoch,
            reviewed: decisions,
          );
        },
        successText: 'Đã ghi nhận kết quả kiểm tra.',
      );
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  String _commandLabel(DecisionCommand command) => switch (command) {
    DecisionCommand.create => 'Tạo quyết định',
    DecisionCommand.edit => 'Chỉnh sửa',
    DecisionCommand.confirm => 'Xác nhận',
    DecisionCommand.reject => 'Từ chối',
  };

  Future<void> _createDecision() async {
    final workspace = widget.workspace;
    final epoch = workspace.reviewEpoch;
    if (workspace.decisionOutcomeUnknown) return;
    final draft = workspace.manualDecisionDraft;
    final input = await showResultsReviewDialog<(String, bool)>(
      context: context,
      workspace: workspace,
      epoch: epoch,
      builder: (_) => _DecisionContentDialog(
        title: 'Tạo quyết định chính thức',
        initial: draft?.content ?? '',
        initialAttach: draft?.attachEvidence ?? false,
        allowEvidence: true,
      ),
    );
    if (input == null || !mounted || !workspace.ownsReview(epoch)) return;
    workspace.keepManualDecisionDraft(
      ManualDecisionDraft(
        input.$1,
        input.$2,
        source: input.$2 ? draft?.source : null,
        evidence: input.$2 ? draft?.evidence ?? const {} : const {},
      ),
      epoch,
    );
    Transcript? source;
    Set<String> selected = {};
    if (input.$2) {
      final projection = await workspace.loadCurrentDecisionProjection();
      if (!mounted || !workspace.ownsReview(epoch)) return;
      source = projection?.transcript;
      if (!workspace.transcriptIsCurrent ||
          projection == null ||
          source == null ||
          source.etag == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Chưa thể tải transcript để chọn bằng chứng.'),
          ),
        );
        return;
      }
      final initialSelection =
          draft?.source?.id == source.id && draft?.source?.etag == source.etag
          ? draft!.evidence
          : const <String>{};
      final evidence = await showResultsReviewDialog<Set<String>>(
        context: context,
        workspace: workspace,
        epoch: epoch,
        builder: (_) => _DecisionEvidencePicker(
          projection: projection,
          initialSelection: initialSelection,
        ),
      );
      if (evidence == null || !mounted || !workspace.ownsReview(epoch)) return;
      selected = evidence;
      workspace.keepManualDecisionDraft(
        ManualDecisionDraft(
          input.$1,
          true,
          source: source,
          evidence: Set.unmodifiable(selected),
        ),
        epoch,
      );
    }
    final saved = await runCommand(
      context,
      operation: () async {
        await workspace.createDecision(
          input.$1,
          epoch: epoch,
          reviewedTranscript: source,
          evidenceSegmentIds: selected.toList(growable: false),
        );
      },
      successText: 'Đã lưu quyết định.',
    );
    if (saved) workspace.keepManualDecisionDraft(null, epoch);
  }

  Future<void> inspect(MeetingDecision decision) async {
    final workspace = widget.workspace;
    final readEpoch = workspace.readEpoch;
    final reviewEpoch = workspace.reviewEpoch;
    final evidence = await workspace.loadDecisionEvidence(decision);
    if (!mounted || !workspace.ownsRead(readEpoch)) return;
    final stamp = workspace.decisionReviewStamp;
    bool current() => workspace.decisionReviewIsCurrent(decision, stamp);
    bool canMutate() =>
        current() &&
        workspace.ownsReview(reviewEpoch) &&
        !workspace.decisionOutcomeUnknown &&
        !workspace.mutationBusy(ResultsMutationGroup.decisions) &&
        decision.etag != null &&
        decision.etag!.trim().isNotEmpty;
    final action = await showResultsReviewDialog<String>(
      context: context,
      workspace: workspace,
      epoch: readEpoch,
      requiresMutation: false,
      builder: (dialog) => AnimatedBuilder(
        animation: workspace,
        builder: (context, _) => AlertDialog(
          title: const Text('Đối chiếu quyết định'),
          content: SizedBox(
            width: 480,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!current())
                    const Text('Nguồn hoặc quyết định đã đổi. Hãy mở lại để đối chiếu.'),
                  StatePill(decision.status),
                  SelectableText(decision.content),
                  ..._provenance(decision),
                  const Divider(),
                  const Text('Bằng chứng transcript'),
                  if (decision.evidenceSegmentIds.isEmpty)
                    const Text('Không có bằng chứng đính kèm.'),
                  if (decision.evidenceSegmentIds.isNotEmpty &&
                      !evidence.hasCompatibleSource)
                    const Text(
                      'Không còn nguồn transcript tương thích hoặc nguồn chưa tải được.',
                    ),
                  for (final id in decision.evidenceSegmentIds)
                    _evidenceTile(dialog, evidence, id),
                  if (decision.status == 'PROPOSED')
                    Text(
                      evidence.canConfirm
                          ? 'Xác nhận sẽ đưa đề xuất vào quyết định chính thức.'
                          : 'Chưa đủ điều kiện xác nhận; vẫn có thể từ chối đề xuất.',
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: const Text('Đóng'),
            ),
            if (canMutate() && decision.status == 'PROPOSED') ...[
              TextButton(
                onPressed: () => Navigator.pop(dialog, 'reject'),
                child: const Text('Từ chối'),
              ),
              FilledButton(
                onPressed: evidence.canConfirm
                    ? () => Navigator.pop(dialog, 'confirm')
                    : null,
                child: const Text('Xác nhận chính thức'),
              ),
            ],
            if (canMutate() && decision.status == 'CONFIRMED')
              FilledButton(
                onPressed: () => Navigator.pop(dialog, 'edit'),
                child: const Text('Chỉnh sửa'),
              ),
          ],
        ),
      ),
    );
    if (action == null || !mounted || !workspace.ownsRead(readEpoch)) return;
    if (action.startsWith('segment:')) {
      final id = action.substring('segment:'.length);
      final source = evidence.projection?.transcript;
      if (source == null) return;
      final result = await TranscriptEvidenceNavigationBoundary(workspace)
          .locate(
            TranscriptEvidenceReference(
              transcriptId: source.id,
              segmentId: id,
              contentRevision: source.contentRevision,
              transcriptEtag: source.etag,
            ),
          );
      if (!mounted || !workspace.ownsRead(readEpoch)) return;
      if (result.status != TranscriptEvidenceNavigationStatus.opened) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Không thể mở đoạn bằng chứng đã ghi.')),
        );
      }
      return;
    }
    if (!workspace.ownsReview(reviewEpoch) || !current()) return;
    if (action == 'edit') {
      await edit(decision, reviewEpoch, stamp);
      return;
    }
    if (action != 'confirm' && action != 'reject') return;
    final confirm = action == 'confirm';
    await runCommand(
      context,
      operation: () {
        workspace.requireDecisionReview(decision, stamp);
        return workspace.reviewDecision(
          decision,
          confirm: confirm,
          epoch: reviewEpoch,
          reviewedEvidence: evidence,
        );
      },
      successText: confirm ? 'Đã xác nhận quyết định.' : 'Đã từ chối đề xuất.',
    );
  }

  Widget _evidenceTile(
    BuildContext dialog,
    DecisionEvidenceReview review,
    String id,
  ) {
    final segment = review.segment(id);
    if (segment == null) {
      return const ListTile(title: Text('Không thể xác minh đoạn bằng chứng.'));
    }
    final speaker = review.projection!.speakerName(segment);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(segment.text),
      subtitle: Text(
        '$speaker · ${segment.startMs ~/ 1000}s–${segment.endMs ~/ 1000}s'
        '\n${switch (review.quality(segment)) {
          DecisionEvidenceQuality.unsafe => 'Cần đối chiếu chất lượng',
          DecisionEvidenceQuality.unknown => 'Chưa đủ thông tin coverage',
          DecisionEvidenceQuality.reviewable => 'Có thể đối chiếu',
        }}',
      ),
      trailing: IconButton(
        tooltip: 'Mở transcript',
        icon: const Icon(Icons.open_in_new),
        onPressed: () => Navigator.pop(dialog, 'segment:$id'),
      ),
    );
  }

  List<Widget> _provenance(MeetingDecision decision) => [
    Text(switch (decision.sourceType) {
      'AI_EXTRACTED' => 'Đề xuất từ AI',
      'MANUAL' => 'Do người dùng tạo',
      _ => 'Nguồn chưa xác định',
    }),
    Text('Tạo lúc: ${dateLabel(decision.createdAt)}'),
    if (decision.createdByUserId != null)
      Text(
        'Người tạo: ${widget.workspace.meetingIdentityLabel(decision.createdByUserId) ?? 'Chưa rõ tên'}',
      ),
    if (decision.confirmedAt != null)
      Text('Xác nhận lúc: ${dateLabel(decision.confirmedAt)}'),
    if (decision.confirmedByUserId != null)
      Text(
        'Người xác nhận: ${widget.workspace.meetingIdentityLabel(decision.confirmedByUserId) ?? 'Chưa rõ tên'}',
      ),
    if (decision.rejectedAt != null)
      Text('Từ chối lúc: ${dateLabel(decision.rejectedAt)}'),
    if (decision.rejectedByUserId != null)
      Text(
        'Người từ chối: ${widget.workspace.meetingIdentityLabel(decision.rejectedByUserId) ?? 'Chưa rõ tên'}',
      ),
    if (decision.stale)
      const Text('Nguồn transcript đã thay đổi; cần đối chiếu.'),
    if (decision.contentRevision != null)
      Text('Revision nguồn: ${decision.contentRevision}'),
    if (decision.aiUncertainty == 'MATERIAL')
      const Text('Có bất định đáng kể về bằng chứng.'),
    for (final warning in decision.aiWarnings)
      Text('Cảnh báo: $warning', style: const TextStyle(color: Palette.amber)),
  ];

  Future<void> edit(
    MeetingDecision decision,
    int epoch,
    DecisionReviewStamp stamp,
  ) async {
    final workspace = widget.workspace;
    final token = decision.etag;
    if (token == null || !workspace.ownsReview(epoch)) return;
    final key = 'decision:${decision.id}';
    final preserved = workspace.recoveryDraft(key);
    var initial = workspace.draftFor(
      key,
      resourceId: decision.id,
      reviewedToken: token,
      epoch: epoch,
    );
    if (preserved != null && initial == null) {
      final choice = await showResultsDraftConflictDialog(
        context: context,
        workspace: workspace,
        epoch: epoch,
        currentContent: decision.content,
        preservedDraft: preserved.content,
      );
      if (!mounted || !workspace.ownsReview(epoch)) return;
      if (choice == ResultsDraftConflictChoice.discard) {
        workspace.clearDraft(key, epoch);
        return;
      }
      if (choice == ResultsDraftConflictChoice.cancel) return;
      initial = preserved.content;
    }
    final input = await showResultsReviewDialog<(String, bool)>(
      context: context,
      workspace: workspace,
      epoch: epoch,
      builder: (_) => _DecisionContentDialog(
        title: 'Chỉnh sửa quyết định đã xác nhận',
        initial: initial ?? decision.content,
      ),
    );
    if (input == null || !mounted || !workspace.ownsReview(epoch)) return;
    workspace.keepDraft(
      key,
      input.$1,
      epoch,
      resourceId: decision.id,
      reviewedToken: token,
    );
    final saved = await runCommand(
      context,
      operation: () {
        workspace.requireDecisionReview(decision, stamp);
        return workspace.editDecision(decision, input.$1, epoch: epoch);
      },
      successText: 'Đã lưu nội dung quyết định.',
    );
    if (saved) workspace.clearDraft(key, epoch);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final workspace = widget.workspace;
      final resource = workspace.decisions;
      final collection = workspace.capabilities.canRead && resource.hasData
          ? resource.data
          : null;
      final items = collection?.items ?? const <MeetingDecision>[];
      final filter = workspace.decisionStatus ?? 'ALL';
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
            child: SectionHeading(
              'Quyết định',
              subtitle: 'Đề xuất AI cần xác nhận để trở thành chính thức.',
              trailing: IconButton(
                tooltip: 'Tạo quyết định',
                onPressed:
                    busy ||
                        workspace.mutationBusy(
                          ResultsMutationGroup.decisions,
                        ) ||
                        !workspace.capabilities.canMutate ||
                        workspace.decisionOutcomeUnknown
                    ? null
                    : createDecision,
                icon: const Icon(Icons.add_circle_outline),
              ),
            ),
          ),
          if (workspace.capabilities.canMutate &&
              workspace.decisionOutcomeUnknown)
            TextButton(
              onPressed: busy ? null : recoverUnknownDecision,
              child: const Text('Kiểm tra thao tác chưa rõ kết quả'),
            ),
          if (workspace.capabilities.canRead)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: DropdownButton<String>(
                isExpanded: true,
                value: filter,
                items: const [
                  DropdownMenuItem(value: 'ALL', child: Text('Tất cả')),
                  DropdownMenuItem(value: 'PROPOSED', child: Text('Đề xuất')),
                  DropdownMenuItem(
                    value: 'CONFIRMED',
                    child: Text('Đã xác nhận'),
                  ),
                  DropdownMenuItem(
                    value: 'REJECTED',
                    child: Text('Đã từ chối'),
                  ),
                ],
                onChanged: (value) {
                  if (value != null) {
                    unawaited(
                      workspace.selectDecisionStatus(
                        value == 'ALL' ? null : value,
                      ),
                    );
                  }
                },
              ),
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => workspace.loadDecisions(force: true),
              child: ListView.builder(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(18),
                itemCount: items.length + 2,
                itemBuilder: (context, index) {
                  if (index == 0) {
                    if (collection == null) {
                      return resultsResourceMessage(
                        resource,
                        label: 'Quyết định',
                        onRetry: () => workspace.loadDecisions(force: true),
                      );
                    }
                    if (items.isEmpty) {
                      return const MessagePanel(title: 'Chưa có quyết định');
                    }
                    return resultsRefreshNotice(
                      resource,
                      () => workspace.loadDecisions(force: true),
                    );
                  }
                  if (index == items.length + 1) {
                    return collection?.hasMore == true
                        ? OutlinedButton(
                            onPressed:
                                resource.phase ==
                                    ResultsResourcePhase.refreshing
                                ? null
                                : () =>
                                      unawaited(workspace.loadMoreDecisions()),
                            child: const Text('Tải thêm quyết định'),
                          )
                        : const SizedBox.shrink();
                  }
                  final decision = items[index - 1];
                  return ContentCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        StatePill(decision.status),
                        SelectableText(decision.content),
                        Text(
                          '${decision.evidenceSegmentIds.length} đoạn bằng chứng',
                        ),
                        if (decision.stale)
                          const Text('Nguồn transcript cần đối chiếu lại.'),
                        TextButton(
                          onPressed: () => unawaited(inspect(decision)),
                          child: const Text('Xem và đối chiếu'),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ),
        ],
      );
    },
  );
}

class _DecisionContentDialog extends StatefulWidget {
  const _DecisionContentDialog({
    required this.title,
    this.initial = '',
    this.initialAttach = false,
    this.allowEvidence = false,
  });

  final String title;
  final String initial;
  final bool allowEvidence;
  final bool initialAttach;

  @override
  State<_DecisionContentDialog> createState() => _DecisionContentDialogState();
}

class _DecisionContentDialogState extends State<_DecisionContentDialog> {
  late final TextEditingController _text = TextEditingController(
    text: widget.initial,
  );
  late bool _attach = widget.initialAttach;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title),
    content: SizedBox(
      width: 480,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _text,
            minLines: 3,
            maxLines: 8,
            maxLength: 5000,
            onChanged: (_) => setState(() {}),
          ),
          if (widget.allowEvidence)
            CheckboxListTile(
              value: _attach,
              title: const Text('Đính kèm bằng chứng transcript'),
              onChanged: (value) => setState(() => _attach = value ?? false),
            ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Hủy'),
      ),
      FilledButton(
        onPressed: _text.text.trim().isEmpty || _text.text.length > 5000
            ? null
            : () => Navigator.pop(context, (_text.text.trim(), _attach)),
        child: const Text('Tiếp tục'),
      ),
    ],
  );
}

class _DecisionEvidencePicker extends StatefulWidget {
  const _DecisionEvidencePicker({
    required this.projection,
    required this.initialSelection,
  });
  final TranscriptReviewProjection projection;
  final Set<String> initialSelection;

  @override
  State<_DecisionEvidencePicker> createState() =>
      _DecisionEvidencePickerState();
}

class _DecisionEvidencePickerState extends State<_DecisionEvidencePicker> {
  late final Set<String> _selected = Set.of(widget.initialSelection);

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('Chọn bằng chứng (${_selected.length}/50)'),
    content: SizedBox(
      width: 480,
      height: 360,
      child: ListView.builder(
        itemCount: widget.projection.transcript.segments.length,
        itemBuilder: (context, index) {
          final segment = widget.projection.transcript.segments[index];
          final selected = _selected.contains(segment.id);
          return CheckboxListTile(
            value: selected,
            title: Text(segment.text),
            subtitle: Text(
              '${widget.projection.speakerName(segment)} · '
              '${segment.startMs ~/ 1000}s · '
              '${switch (decisionEvidenceQuality(widget.projection, segment)) {
                DecisionEvidenceQuality.reviewable => 'Có thể đối chiếu',
                DecisionEvidenceQuality.unknown => 'Chưa đủ thông tin coverage',
                DecisionEvidenceQuality.unsafe => 'Cần đối chiếu chất lượng',
              }}',
            ),
            onChanged: selected || _selected.length < 50
                ? (value) => setState(() {
                    if (value == true) {
                      _selected.add(segment.id);
                    } else {
                      _selected.remove(segment.id);
                    }
                  })
                : null,
          );
        },
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Hủy'),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, Set<String>.of(_selected)),
        child: const Text('Xác nhận lựa chọn'),
      ),
    ],
  );
}
