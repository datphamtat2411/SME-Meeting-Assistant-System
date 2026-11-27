import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_dependencies.dart';
import '../../core/widgets.dart';
import '../action_items/action_item_presentation.dart';
import '../action_items/action_items_page.dart';
import '../recording/processing_manager.dart';
import 'decisions_review_panel.dart';
import 'minutes_panel.dart';
import 'results_action_item_routes.dart';
import 'results_workspace_controller.dart';
import 'results_invalidation.dart';
import 'results_models.dart';
import 'speaker_mapping_panel.dart';
import 'summary_history_panel.dart';
import 'transcript_review_panel.dart';

enum ResultsSection {
  summary,
  transcript,
  decisions,
  actionItems,
  speakers,
  minutes,
}

class ResultsPanel extends StatefulWidget {
  const ResultsPanel({
    super.key,
    required this.workspace,
    this.dependencies,
    this.initialSection = ResultsSection.summary,
    this.reviewHandoff,
    this.onReviewAdmitted,
  });

  final ResultsWorkspaceController workspace;
  final AppDependencies? dependencies;
  final ResultsSection initialSection;
  final TranscriptReviewHandoff? reviewHandoff;
  final ValueChanged<TranscriptReviewHandoff>? onReviewAdmitted;

  @override
  State<ResultsPanel> createState() => _ResultsPanelState();
}

class _ResultsPanelState extends State<ResultsPanel> {
  late ResultsSection selected;
  TranscriptFocusRequest? _handledFocus;

  Set<ResultsResourceKind> _resourcesFor(ResultsSection section) =>
      switch (section) {
        ResultsSection.summary => {ResultsResourceKind.summary},
        ResultsSection.transcript => {
          ResultsResourceKind.transcript,
          ResultsResourceKind.coverage,
          ResultsResourceKind.speakers,
        },
        ResultsSection.decisions => {ResultsResourceKind.decisions},
        ResultsSection.actionItems => {},
        ResultsSection.speakers => {ResultsResourceKind.speakers},
        ResultsSection.minutes => {ResultsResourceKind.minutes},
      };

  ResultsSection get _initial =>
      widget.dependencies == null &&
          widget.initialSection == ResultsSection.actionItems
      ? ResultsSection.summary
      : widget.initialSection;

  void _activate(ResultsWorkspaceController workspace) {
    workspace.activateResources(
      _resourcesFor(selected),
      observeActionItems: selected == ResultsSection.actionItems,
    );
  }

  @override
  void initState() {
    super.initState();
    selected = _initial;
    widget.workspace.addListener(_workspaceChanged);
    _workspaceChanged();
    _scheduleActivation(widget.workspace);
  }

  @override
  void dispose() {
    widget.workspace.removeListener(_workspaceChanged);
    widget.workspace.deactivate();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ResultsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.workspace, widget.workspace)) {
      oldWidget.workspace.removeListener(_workspaceChanged);
      oldWidget.workspace.deactivate();
      selected = _initial;
      _handledFocus = null;
      widget.workspace.addListener(_workspaceChanged);
      _workspaceChanged();
      _scheduleActivation(widget.workspace);
    }
  }

  void _workspaceChanged() {
    final workspace = widget.workspace;
    final request = workspace.transcriptFocus;
    if (request == null || identical(request, _handledFocus)) return;
    _handledFocus = request;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !identical(widget.workspace, workspace) ||
          !identical(workspace.transcriptFocus, request)) {
        return;
      }
      setState(() => selected = ResultsSection.transcript);
      _activate(workspace);
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _scheduleActivation(ResultsWorkspaceController workspace) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !identical(widget.workspace, workspace)) return;
      _activate(workspace);
    });
  }

  Widget _actionItems(
    ResultsWorkspaceController current,
    int epoch,
    AppDependencies dependencies,
  ) => ActionItemsPage(
    dependencies: dependencies,
    meetingId: current.meetingId,
    hostIsCurrent: () => current.ownsRead(epoch),
    openDetailRoute: (context, id) => openResultsActionItemDetail(
      context: context,
      workspace: current,
      epoch: epoch,
      dependencies: dependencies,
      itemId: id,
    ),
    openCreateRoute: (context, meetingId) => openResultsActionItemCreation(
      context: context,
      workspace: current,
      epoch: epoch,
      dependencies: dependencies,
      meetingId: meetingId,
    ),
    openAssigneeFilter: (context, readKnown, changes) => pickActionItemAssignee(
      context,
      dependencies.actionItems,
      readKnown: readKnown,
      knownChanges: changes,
      allowKnownInactive: true,
      forFilter: true,
      hostIsCurrent: () => current.ownsRead(epoch),
      openPicker: (context, picker) => openResultsOwnedPage(
        context: context,
        workspace: current,
        epoch: epoch,
        nested: false,
        builder: (_, _) => picker,
      ),
    ),
  );

  Widget _page(ResultsWorkspaceController current) {
    final dependencies = widget.dependencies;
    final epoch = current.readEpoch;
    return switch (selected) {
      ResultsSection.summary => SummaryHistoryPanel(workspace: current),
      ResultsSection.transcript => TranscriptReviewPanel(
        workspace: current,
        reviewHandoff: widget.reviewHandoff,
        onReviewAdmitted: widget.onReviewAdmitted,
      ),
      ResultsSection.decisions => DecisionsReviewPanel(workspace: current),
      ResultsSection.actionItems => _actionItems(current, epoch, dependencies!),
      ResultsSection.speakers => SpeakerMappingPanel(workspace: current),
      ResultsSection.minutes => MinutesPanel(
        workspace: current,
        openActionItem: dependencies == null
            ? null
            : (context, id) => openResultsActionItemDetail(
                context: context,
                workspace: current,
                epoch: epoch,
                dependencies: dependencies,
                itemId: id,
              ),
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.workspace;
    final tabs = <(ResultsSection, String, IconData)>[
      (ResultsSection.summary, 'Tóm tắt', Icons.auto_awesome_outlined),
      (ResultsSection.transcript, 'Transcript', Icons.notes_outlined),
      (ResultsSection.decisions, 'Quyết định', Icons.fact_check_outlined),
      if (widget.dependencies != null)
        (ResultsSection.actionItems, 'Công việc', Icons.checklist),
      (ResultsSection.speakers, 'Người nói', Icons.record_voice_over_outlined),
      (ResultsSection.minutes, 'Biên bản', Icons.article_outlined),
    ];
    return Column(
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(
            children: [
              for (final tab in tabs)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    avatar: Icon(tab.$3, size: 17),
                    label: Text(tab.$2),
                    selected: selected == tab.$1,
                    onSelected: (_) {
                      setState(() => selected = tab.$1);
                      _activate(current);
                    },
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: AnimatedBuilder(
            animation: current,
            builder: (context, _) => current.capabilities.canRead
                ? KeyedSubtree(
                    key: ValueKey((current, current.readEpoch)),
                    child: _page(current),
                  )
                : MessagePanel(
                    title:
                        'Không thể xác minh quyền truy cập kết quả cuộc họp.',
                    onRetry: () => unawaited(current.retryAccess()),
                  ),
          ),
        ),
      ],
    );
  }
}
