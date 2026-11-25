import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/date_labels.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';
import 'results_models.dart';

class TranscriptReviewPanel extends StatefulWidget {
  const TranscriptReviewPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<TranscriptReviewPanel> createState() => _TranscriptReviewPanelState();
}

class _TranscriptReviewPanelState extends State<TranscriptReviewPanel> {
  final search = TextEditingController();
  String speakerFilter = 'Tất cả';
  String qualityFilter = 'Tất cả';
  final _scroll = ScrollController();
  final _anchor = GlobalKey();
  TranscriptFocusRequest? _focus;

  @override
  void initState() {
    super.initState();
    widget.workspace.addListener(_workspaceChanged);
    _workspaceChanged();
  }

  void _workspaceChanged() {
    final workspace = widget.workspace;
    final request = workspace.transcriptFocus;
    if (identical(request, _focus)) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !identical(widget.workspace, workspace) ||
          !identical(workspace.transcriptFocus, request)) {
        return;
      }
      setState(() {
        _focus = request;
        if (request != null) {
          search.clear();
          speakerFilter = 'Tất cả';
          qualityFilter = 'Tất cả';
        }
      });
      _jumpToAnchor();
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _jumpToAnchor() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) _scroll.jumpTo(0);
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  void dispose() {
    widget.workspace.removeListener(_workspaceChanged);
    _scroll.dispose();
    search.dispose();
    super.dispose();
  }

  Future<void> edit(SpeechSegment segment) async {
    final epoch = widget.workspace.reviewEpoch;
    final draftKey = 'segment:${segment.id}';
    final preserved = widget.workspace.recoveryDraft(draftKey);
    var initial = widget.workspace.draftFor(
      draftKey,
      resourceId: segment.id,
      reviewedToken: segment.etag ?? '',
      epoch: epoch,
    );
    if (preserved != null && initial == null) {
      final choice = await showResultsDraftConflictDialog(
        context: context,
        workspace: widget.workspace,
        epoch: epoch,
        currentContent: segment.text,
        preservedDraft: preserved.content,
      );
      if (!mounted || !widget.workspace.ownsReview(epoch)) return;
      if (choice == ResultsDraftConflictChoice.discard) {
        widget.workspace.clearDraft(draftKey, epoch);
        return;
      }
      if (choice == ResultsDraftConflictChoice.cancel) return;
      initial = preserved.content;
    }
    final controller = TextEditingController(text: initial ?? segment.text);
    final reasonController = TextEditingController();
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      builder: (dialog) => AlertDialog(
        title: const Text('Chỉnh sửa đoạn transcript'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: controller,
              maxLength: 20000,
              minLines: 3,
              maxLines: 8,
              decoration: const InputDecoration(labelText: 'Nội dung hiện tại'),
            ),
            TextField(
              controller: reasonController,
              maxLength: 1000,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Lý do chỉnh sửa (không bắt buộc)',
              ),
            ),
          ],
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
    if (ok != true || !mounted || !widget.workspace.ownsReview(epoch)) {
      controller.dispose();
      reasonController.dispose();
      return;
    }
    final value = controller.text.trim();
    final reason = reasonController.text.trim();
    controller.dispose();
    reasonController.dispose();
    if (value.isEmpty) return;
    widget.workspace.keepDraft(
      draftKey,
      value,
      epoch,
      resourceId: segment.id,
      reviewedToken: segment.etag ?? '',
    );
    final saved = await runCommand(
      context,
      operation: () => widget.workspace.correctSegment(
        segment,
        value,
        epoch: epoch,
        reason: reason.isEmpty ? null : reason,
      ),
      successText: 'Đã cập nhật transcript.',
    );
    if (saved) widget.workspace.clearDraft(draftKey, epoch);
  }

  String _fold(String value) => value
      .toLowerCase()
      .replaceAllMapped(RegExp('[àáạảãâầấậẩẫăằắặẳẵ]'), (_) => 'a')
      .replaceAllMapped(RegExp('[èéẹẻẽêềếệểễ]'), (_) => 'e')
      .replaceAllMapped(RegExp('[ìíịỉĩ]'), (_) => 'i')
      .replaceAllMapped(RegExp('[òóọỏõôồốộổỗơờớợởỡ]'), (_) => 'o')
      .replaceAllMapped(RegExp('[ùúụủũưừứựửữ]'), (_) => 'u')
      .replaceAllMapped(RegExp('[ỳýỵỷỹ]'), (_) => 'y')
      .replaceAll('đ', 'd');

  String _qualityLabel(String quality) => switch (quality) {
    'ACCEPTED' => 'Đã chấp nhận',
    'SUSPICIOUS' => 'Cần kiểm tra',
    'UNRESOLVED' => 'Chưa giải quyết',
    _ => quality,
  };

  void _focusRegion(TranscriptReviewProjection projection, TranscriptCoverageRegion region) {
    final segment = projection.transcript.segments
        .where((segment) =>
            segment.startMs < region.endMs && segment.endMs > region.startMs)
        .firstOrNull;
    if (segment == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Không có đoạn transcript tại vùng này.')),
      );
      return;
    }
    widget.workspace.focusTranscriptSegment(
      TranscriptFocusRequest(
        transcriptId: projection.transcript.id,
        transcriptEtag: projection.transcript.etag,
        segmentId: segment.id,
        readEpoch: widget.workspace.readEpoch,
      ),
    );
  }

  Future<void> _refreshReview() async {
    await Future.wait([
      widget.workspace.loadTranscript(force: true),
      widget.workspace.loadCoverage(force: true),
      widget.workspace.loadSpeakers(force: true),
    ]);
  }

  Widget _coverageOverview(TranscriptReviewProjection projection) {
    final coverage = projection.coverage;
    if (coverage == null) {
      return MessagePanel(
        title: widget.workspace.coverage.phase == ResultsResourcePhase.loading
            ? 'Đang tải thông tin coverage'
            : 'Chưa có coverage phù hợp với transcript hiện tại',
        description: 'Chưa thể đánh giá độ bao phủ của bản transcript này.',
        onRetry: _refreshReview,
      );
    }
    final concerns = coverage.regions
        .where((region) => region.status != 'COVERED')
        .toList(growable: false);
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Coverage âm thanh',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          Text(
            coverage.regions.isEmpty
                ? 'Chưa có bằng chứng để đánh giá độ bao phủ.'
                : concerns.isEmpty
                ? '${coverage.regions.length} vùng có bằng chứng; không có cảnh báo trong các vùng đã ghi nhận.'
                : '${concerns.length} vùng cần chú ý trong timeline.',
            style: const TextStyle(color: Palette.muted),
          ),
          ...projection.reviewRegions.map(
            (region) => ListTile(
              contentPadding: EdgeInsets.zero,
              onTap: () => _focusRegion(projection, region),
              leading: Icon(
                region.status == 'UNRESOLVED_ERROR'
                    ? Icons.error_outline
                    : region.status == 'COVERED'
                    ? Icons.check_circle_outline
                    : Icons.warning_amber_outlined,
                color: region.status == 'UNRESOLVED_ERROR'
                    ? Palette.red
                    : Palette.amber,
              ),
              title: Text(
                '${durationLabel(region.startMs)}–${durationLabel(region.endMs)} · '
                '${region.status == 'UNRESOLVED_ERROR' ? 'Không khôi phục được' : region.status == 'COVERED' ? 'Đã bao phủ' : 'Đáng ngờ'}',
              ),
              subtitle: Text(
                region.recovered
                    ? 'Đã khôi phục sau ${region.retryCount} lần thử'
                    : 'Chưa có bằng chứng khôi phục',
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _segmentCard(
    SpeechSegment segment,
    TranscriptReviewProjection projection, {
    bool focused = false,
  }) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (focused)
          const StatePill('READY', label: 'Đoạn đang tham chiếu'),
        Row(
          children: [
            Expanded(
              child: Text(
                projection.speakerName(segment),
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            Text(
              '${durationLabel(segment.startMs)}–${durationLabel(segment.endMs)}',
              style: const TextStyle(fontSize: 12, color: Palette.muted),
            ),
            IconButton(
              icon: const Icon(Icons.edit_note_outlined),
              onPressed:
                  widget.workspace.capabilities.canMutate &&
                      !widget.workspace.mutationBusy(
                        ResultsMutationGroup.transcript,
                      ) &&
                      segment.etag != null &&
                      segment.etag!.trim().isNotEmpty
                  ? () => edit(segment)
                  : null,
              tooltip: segment.etag == null
                  ? 'Thiếu phiên bản máy chủ; chỉ có thể đọc'
                  : 'Chỉnh sửa đoạn transcript',
            ),
          ],
        ),
        SelectableText(segment.text),
        if (segment.quality.isNotEmpty && segment.quality != 'ACCEPTED')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: StatePill(
              segment.quality,
              label: _qualityLabel(segment.quality),
            ),
          ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.transcript;
      final transcript = resource.hasData ? resource.data : null;
      if (transcript == null) {
        return resultsResourceMessage(
          resource,
          label: 'Transcript',
          onRetry: () => widget.workspace.loadTranscript(force: true),
        );
      }
      final projection = TranscriptReviewProjection(
        transcript,
        coverage: widget.workspace.coverage.hasData
            ? widget.workspace.coverage.data
            : null,
        speakers: widget.workspace.speakers.hasData
            ? widget.workspace.speakers.data
            : null,
      );
      final query = _fold(search.text.trim());
      final speakers = <String, String>{
        'Tất cả': 'Tất cả',
        for (final segment in transcript.segments)
          projection.speakerKey(segment): projection.speakerName(segment),
      };
      final qualities = <String>{
        'Tất cả',
        ...transcript.segments.map((segment) => segment.quality),
      }.toList()..sort();
      if (!speakers.containsKey(speakerFilter)) speakerFilter = 'Tất cả';
      if (!qualities.contains(qualityFilter)) qualityFilter = 'Tất cả';
      final visible = transcript.segments
          .where((segment) {
            final matchesText =
                query.isEmpty ||
                _fold(segment.text).contains(query) ||
                _fold(projection.speakerName(segment)).contains(query) ||
                _fold(segment.speakerLabel ?? '').contains(query);
            final matchesSpeaker =
                speakerFilter == 'Tất cả' ||
                projection.speakerKey(segment) == speakerFilter;
            final matchesQuality =
                qualityFilter == 'Tất cả' || segment.quality == qualityFilter;
            return matchesText && matchesSpeaker && matchesQuality;
          })
          .toList(growable: false);
      final focus = _focus;
      final focusIndex = focus != null &&
              widget.workspace.ownsRead(focus.readEpoch) &&
              transcript.id == focus.transcriptId &&
              transcript.etag == focus.transcriptEtag
          ? visible.indexWhere((segment) => segment.id == focus.segmentId)
          : -1;
      final anchorIndex = focusIndex < 0 ? 0 : focusIndex;
      return Column(
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
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Row(
              children: [
                Expanded(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: speakerFilter,
                    onChanged: (value) =>
                        setState(() => speakerFilter = value ?? 'Tất cả'),
                    items: speakers.entries
                        .map(
                          (value) => DropdownMenuItem(
                            value: value.key,
                            child: Text(value.value, overflow: TextOverflow.ellipsis),
                          ),
                        )
                        .toList(),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: qualityFilter,
                    onChanged: (value) =>
                        setState(() => qualityFilter = value ?? 'Tất cả'),
                    items: qualities
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(
                              value == 'Tất cả' ? value : _qualityLabel(value),
                            ),
                          ),
                        )
                        .toList(),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _refreshReview,
              child: CustomScrollView(
                controller: _scroll,
                center: focusIndex < 0 ? null : _anchor,
                physics: const AlwaysScrollableScrollPhysics(),
                slivers: [
                  SliverPadding(
                    padding: const EdgeInsets.all(18),
                    sliver: SliverToBoxAdapter(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SectionHeading(
                            'Transcript',
                            subtitle:
                                '${transcript.segments.length} đoạn phát biểu · '
                                'bản ${transcript.versionNumber} · ${transcript.status}',
                          ),
                          resultsRefreshNotice(
                            resource,
                            () => widget.workspace.loadTranscript(force: true),
                          ),
                          _coverageOverview(projection),
                          if (transcript.segments.isEmpty)
                            const MessagePanel(
                              title: 'Transcript trống theo dữ liệu chuẩn',
                            ),
                          if (transcript.segments.isNotEmpty && visible.isEmpty)
                            const MessagePanel(
                              title: 'Không tìm thấy nội dung phù hợp',
                            ),
                        ],
                      ),
                    ),
                  ),
                  if (anchorIndex > 0)
                    SliverList(
                      delegate: SliverChildBuilderDelegate(
                        (context, index) => Padding(
                          padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                          child: _segmentCard(
                            visible[anchorIndex - index - 1],
                            projection,
                          ),
                        ),
                        childCount: anchorIndex,
                      ),
                    ),
                  SliverList(
                    key: _anchor,
                    delegate: SliverChildBuilderDelegate(
                      (context, index) => Padding(
                        padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                        child: _segmentCard(
                          visible[anchorIndex + index],
                          projection,
                          focused: focusIndex >= 0 && index == 0,
                        ),
                      ),
                      childCount: visible.length - anchorIndex,
                    ),
                  ),
                  const SliverPadding(padding: EdgeInsets.only(bottom: 24)),
                ],
              ),
            ),
          ),
        ],
      );
    },
  );
}
