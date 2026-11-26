import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_dependencies.dart';
import '../action_items/action_item_create_sheet.dart';
import '../action_items/action_item_detail_sheet.dart';
import 'results_workspace_controller.dart';

/// A full-screen route owns its own child navigator. Revoking the Results read
/// epoch removes the entire route subtree, including pickers and dialogs,
/// without touching any independent global Action Item route.
Future<T?> openResultsOwnedPage<T>({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required int epoch,
  required Widget Function(bool Function(), ValueChanged<T?>) builder,
  bool nested = true,
}) async {
  if (!context.mounted || !workspace.ownsRead(epoch)) return null;
  final registration = workspace.registerProtectedDialog(
    epoch,
    requiresMutation: false,
  );
  final navigator = Navigator.of(context);
  late final MaterialPageRoute<T> route;
  void close(T? value) {
    if (registration.isValid && navigator.mounted && route.isCurrent) {
      navigator.pop<T>(value);
    }
  }

  route = MaterialPageRoute<T>(
    builder: (_) => AnimatedBuilder(
      animation: registration,
      builder: (context, _) {
        registration.attach(context);
        if (!registration.isValid) return const SizedBox.shrink();
        final root = builder(() => registration.isValid, close);
        return nested ? _OwnedActionItemNavigator<T>(root: root) : root;
      },
    ),
  );
  try {
    final result = await navigator.push<T>(route);
    return registration.isValid ? result : null;
  } finally {
    registration.dispose();
  }
}

class _OwnedActionItemNavigator<T> extends StatefulWidget {
  const _OwnedActionItemNavigator({required this.root});

  final Widget root;

  @override
  State<_OwnedActionItemNavigator<T>> createState() =>
      _OwnedActionItemNavigatorState<T>();
}

class _OwnedActionItemNavigatorState<T>
    extends State<_OwnedActionItemNavigator<T>> {
  final _navigator = GlobalKey<NavigatorState>();

  @override
  Widget build(BuildContext context) => PopScope<T>(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (didPop) return;
      final child = _navigator.currentState;
      if (child != null) unawaited(child.maybePop());
    },
    child: Navigator(
      key: _navigator,
      onGenerateRoute: (settings) => MaterialPageRoute<void>(
        settings: settings,
        builder: (_) => widget.root,
      ),
    ),
  );
}

Future<void> openResultsActionItemDetail({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required int epoch,
  required AppDependencies dependencies,
  required String itemId,
}) async {
  await openResultsOwnedPage<void>(
    context: context,
    workspace: workspace,
    epoch: epoch,
    builder: (current, close) => ActionItemDetailPage(
      repository: dependencies.actionItems,
      admission: dependencies.actionItemWorkflows.admission,
      itemId: itemId,
      expectedMeetingId: workspace.meetingId,
      hostIsCurrent: current,
      onClose: () => close(null),
    ),
  );
}

Future<bool?> openResultsActionItemCreation({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required int epoch,
  required AppDependencies dependencies,
  required String? meetingId,
}) => openResultsOwnedPage<bool>(
  context: context,
  workspace: workspace,
  epoch: epoch,
  builder: (current, close) => ActionItemCreatePage(
    controller: dependencies.actionItemWorkflows.creation,
    initialMeetingId: meetingId,
    recoveryOnly: meetingId == null,
    hostIsCurrent: current,
    onClose: close,
  ),
);
