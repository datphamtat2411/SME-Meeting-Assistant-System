import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/date_labels.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';

import 'assistant_evidence_resolver.dart';
import 'assistant_repository.dart';

/// The destination owns its read lifetime independently of the suspended
/// Assistant host. Only an artifact verified for this generation is rendered.
class AssistantEvidencePage extends StatefulWidget {
  const AssistantEvidencePage({
    super.key,
    required this.dependencies,
    required this.target,
    required this.resolver,
  });

  final AppDependencies dependencies;
  final AssistantEvidenceTarget target;
  final AssistantEvidenceResolver resolver;

  @override
  State<AssistantEvidencePage> createState() => _AssistantEvidencePageState();
}

class _AssistantEvidencePageState extends State<AssistantEvidencePage>
    with WidgetsBindingObserver {
  AssistantEvidenceArtifact? _artifact;
  Object? _failure;
  bool _foreground = true;
  bool _visible = false;
  bool _dirty = false;
  bool _running = false;
  bool _scheduled = false;
  int _generation = 0;

  bool get _active =>
      mounted &&
      _visible &&
      _foreground &&
      widget.dependencies.api.isCurrentAuthenticatedSession(
        widget.target.scope,
      );

  @override
  void initState() {
    super.initState();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    widget.dependencies.api.sessionCoordinator.addListener(_sessionChanged);
    widget.dependencies.meetingInvalidation.addListener(_meetingChanged);
    widget.dependencies.resultsInvalidation.addListener(_resultsChanged);
    widget.dependencies.actionItemInvalidation.addListener(_actionChanged);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final visible = ModalRoute.isCurrentOf(context) ?? true;
    if (_visible == visible) return;
    _visible = visible;
    _generation++;
    _artifact = null;
    _failure = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _active) _invalidate();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (_foreground == foreground) return;
    _foreground = foreground;
    _invalidate();
  }

  void _sessionChanged() {
    if (!widget.dependencies.api.isCurrentAuthenticatedSession(
      widget.target.scope,
    )) {
      _invalidate();
    }
  }

  bool _relevant(String? meetingId) =>
      meetingId == null ||
      sameAssistantIdentity(meetingId, widget.target.citation.meetingId);

  void _meetingChanged() {
    final signal = widget.dependencies.meetingInvalidation;
    if (signal.sessionScope == widget.target.scope &&
        _relevant(signal.lastMeetingId)) {
      _invalidate();
    }
  }

  void _resultsChanged() {
    final signal = widget.dependencies.resultsInvalidation;
    if (signal.sessionScope == widget.target.scope &&
        _relevant(signal.meetingId)) {
      _invalidate();
    }
  }

  void _actionChanged() {
    final signal = widget.dependencies.actionItemInvalidation;
    if (signal.sessionScope == widget.target.scope &&
        _relevant(signal.lastMeetingId)) {
      _invalidate();
    }
  }

  void _invalidate() {
    if (!mounted) return;
    setState(() {
      _generation++;
      _artifact = null;
      _failure = null;
      _dirty = _active;
    });
    if (!_active || _running || _scheduled) return;
    _scheduled = true;
    scheduleMicrotask(() {
      _scheduled = false;
      if (_active) unawaited(_verify());
    });
  }

  Future<void> _verify() async {
    if (_running) return;
    _running = true;
    try {
      while (_active && _dirty) {
        _dirty = false;
        final generation = _generation;
        bool owns() => _active && generation == _generation;
        try {
          final artifact = await widget.resolver.verify(
            widget.target,
            stillCurrent: owns,
          );
          if (owns()) setState(() => _artifact = artifact);
        } on Object catch (error) {
          if (owns()) {
            if (error is AssistantEvidenceFailure &&
                error.issue == AssistantEvidenceIssue.meetingUnavailable) {
              widget.dependencies.forgetAssistantMeeting(
                widget.target.scope,
                widget.target.citation.meetingId,
              );
            }
            setState(() => _failure = error);
          }
        }
      }
    } finally {
      _running = false;
    }
  }

  @override
  void dispose() {
    _generation++;
    _dirty = false;
    _artifact = null;
    WidgetsBinding.instance.removeObserver(this);
    widget.dependencies.api.sessionCoordinator.removeListener(_sessionChanged);
    widget.dependencies.meetingInvalidation.removeListener(_meetingChanged);
    widget.dependencies.resultsInvalidation.removeListener(_resultsChanged);
    widget.dependencies.actionItemInvalidation.removeListener(_actionChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final artifact = _active ? _artifact : null;
    final failure = _active ? _failure : null;
    return Scaffold(
      appBar: AppBar(title: const Text('Nguồn tham chiếu')),
      body: SafeArea(
        child: artifact == null
            ? Center(
                child: !widget.dependencies.api.isCurrentAuthenticatedSession(
                  widget.target.scope,
                )
                    ? const Text('Phiên đăng nhập không còn khả dụng.')
                    : failure == null
                    ? const CircularProgressIndicator()
                    : Padding(
                        padding: const EdgeInsets.all(20),
                        child: MessagePanel(
                          title: 'Chưa xác minh được nguồn',
                          description: assistantEvidenceFailureLabel(failure),
                          onRetry: _invalidate,
                        ),
                      ),
              )
            : _content(artifact),
      ),
    );
  }

  Widget _heading(String title, {String? detail}) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const StatePill('READY', label: 'Đã đối chiếu nguồn'),
        SectionHeading(
          title,
          subtitle:
              'Revision ${widget.target.citation.sourceRevision} · Chỉ đọc',
        ),
        if (_artifact?.meetingTitle case final String meetingTitle)
          Text(meetingTitle),
        if (detail != null) Text(detail),
      ],
    ),
  );

  Widget _content(AssistantEvidenceArtifact artifact) => switch (artifact) {
    TranscriptEvidence(:final transcript) => ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: transcript.segments.length + 1,
      itemBuilder: (context, index) {
        if (index == 0) {
          return _heading(
            'Bản chép lời',
            detail:
                'Đang xem bản chép lời được trích dẫn. Trích dẫn này '
                'không xác định một đoạn hoặc thời điểm cụ thể.',
          );
        }
        final segment = transcript.segments[index - 1];
        final projection = TranscriptReviewProjection(transcript);
        return ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(projection.speakerName(segment)),
              Text(
                '${durationLabel(segment.startMs)}–${durationLabel(segment.endMs)}',
                style: Theme.of(context).textTheme.labelMedium,
              ),
              const SizedBox(height: 8),
              SelectableText(segment.text),
              if (segment.quality != 'ACCEPTED') StatePill(segment.quality),
            ],
          ),
        );
      },
    ),
    SummaryEvidence(:final summary) => ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _heading('Tóm tắt cuộc họp'),
        ContentCard(child: SelectableText(summary.content)),
      ],
    ),
    DecisionEvidence(:final decision) => ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _heading('Quyết định'),
        ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              StatePill(decision.status),
              const SizedBox(height: 8),
              SelectableText(decision.content),
            ],
          ),
        ),
      ],
    ),
    ActionItemEvidence(:final item) => ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _heading('Công việc'),
        ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              StatePill(item.status.apiValue),
              SectionHeading(item.title),
              if (item.details != null) SelectableText(item.details!),
              if (item.assignee != null)
                Text('Phụ trách: ${item.assignee!.displayName}'),
              if (item.dueDate != null)
                Text('Hạn: ${localDateLabel(item.dueDate)}'),
            ],
          ),
        ),
      ],
    ),
  };
}
