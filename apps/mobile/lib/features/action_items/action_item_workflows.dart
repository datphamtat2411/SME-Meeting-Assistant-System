import 'action_item_creation.dart';
import 'action_item_detail.dart';
import 'action_item_repository.dart';

/// Feature lifetime owner. Individual routes borrow the same creation
/// recovery controller and mutation admission boundary.
class ActionItemWorkflowOwner {
  ActionItemWorkflowOwner(this.repository);

  final ActionItemRepository repository;
  final ActionItemMutationAdmission admission = ActionItemMutationAdmission();
  ActionItemCreationController? _creation;
  bool _disposed = false;

  ActionItemCreationController get creation {
    if (_disposed) throw StateError('Action Item workflows are disposed.');
    final previous = _creation;
    if (previous != null && previous.current) return previous;
    // An obsolete session's controller clears protected state through its
    // session listener. A new session must receive a new recovery owner.
    previous?.dispose();
    return _creation = ActionItemCreationController(repository: repository);
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _creation?.dispose();
    _creation = null;
  }
}
