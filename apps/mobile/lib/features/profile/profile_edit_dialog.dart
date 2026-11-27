import 'package:flutter/material.dart';

import 'account_resource_view.dart';
import 'profile_controllers.dart';
import 'profile_models.dart';
import 'profile_repository.dart';

/// The editor owns the live form draft; unresolved submitted intent belongs
/// to the session-scoped controller and survives closing the editor.
class ProfileEditDialog extends StatefulWidget {
  const ProfileEditDialog({
    super.key,
    required this.controller,
    required this.original,
    required this.initialName,
  });

  final ProfileController controller;
  final ProfileSnapshot original;
  final String initialName;

  @override
  State<ProfileEditDialog> createState() => _ProfileEditDialogState();
}

class _ProfileEditDialogState extends State<ProfileEditDialog> {
  late final TextEditingController _name;
  bool _submitting = false;
  String? _validation;

  ProfileController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.initialName);
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save(ProfileSnapshot? reviewed) async {
    if (_submitting || !controller.current) return;
    final value = normalizeDisplayName(_name.text);
    if (!isValidDisplayName(value)) {
      setState(() {
        _validation = value.trim().isEmpty
            ? 'Vui lòng nhập tên hiển thị.'
            : 'Tên hiển thị không được vượt quá 200 đơn vị UTF-16.';
      });
      return;
    }
    setState(() {
      _validation = null;
      _submitting = true;
    });
    try {
      final saved = reviewed == null
          ? await controller.updateName(widget.original, value)
          : await controller.confirmPending(reviewed, value);
      if (!mounted || !controller.current) return;
      if (saved) {
        Navigator.pop(context, true);
        return;
      }
      final category = controller.failure?.category;
      if (controller.needsReconciliation &&
          (category == ProfileFailureCategory.conflict ||
              category == ProfileFailureCategory.missingPrecondition)) {
        await controller.refresh();
        if (!mounted || !controller.current) return;
        if (controller.reconciled && controller.pendingEdit == null) {
          Navigator.pop(context, true);
        }
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _check() async {
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      await controller.refresh();
      if (mounted &&
          controller.current &&
          controller.reconciled &&
          controller.pendingEdit == null) {
        Navigator.pop(context, true);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final snapshot = controller.snapshot;
      final pending = controller.pendingEdit;
      final unavailable = !controller.current || snapshot == null;
      final busy = _submitting || controller.saving;
      final checking = controller.needsReconciliation;
      final reviewing = pending != null && !checking;
      final canSave =
          !busy &&
          (checking
              ? controller.canRefresh
              : reviewing
              ? controller.canConfirmPending
              : !controller.loading && controller.canMutate);
      return PopScope(
        canPop: !busy,
        child: AlertDialog(
          scrollable: true,
          title: const Text('Cập nhật tên hiển thị'),
          content: !controller.current || snapshot == null
              ? const Text('Hồ sơ không còn khả dụng. Vui lòng đóng cửa sổ.')
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (pending != null) ...[
                      Text(
                        checking
                            ? 'Cần kiểm tra lại dữ liệu máy chủ trước khi lưu tiếp.'
                            : 'Dữ liệu đã thay đổi hoặc yêu cầu trước chưa được xác nhận. Hãy xem lại trước khi lưu.',
                      ),
                      const SizedBox(height: 8),
                      Text(
                        checking
                            ? 'Tên xác nhận gần nhất: ${snapshot.profile.displayName}'
                            : 'Tên hiện tại trên máy chủ: ${snapshot.profile.displayName}',
                      ),
                      Text('Tên đã gửi hoặc dự định lưu: ${pending.name}'),
                      const SizedBox(height: 12),
                    ],
                    TextField(
                      controller: _name,
                      enabled: !busy && !checking,
                      textCapitalization: TextCapitalization.words,
                      decoration: InputDecoration(
                        labelText: 'Tên hiển thị',
                        errorText: _validation,
                        helperText:
                            '${normalizeDisplayName(_name.text).length} / 200',
                      ),
                      onChanged: (_) => setState(() => _validation = null),
                    ),
                    const SizedBox(height: 8),
                    if (controller.failure != null)
                      Text(
                        profileFailureLabel(controller.failure!),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    if (controller.retryNotBefore case final deadline?)
                      AccountRetryNotice(deadline: deadline),
                    if (busy || controller.loading)
                      const LinearProgressIndicator(),
                  ],
                ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(context, false),
              child: Text(unavailable ? 'Đóng' : 'Hủy'),
            ),
            if (!unavailable && reviewing)
              TextButton(
                onPressed: busy || controller.loading
                    ? null
                    : () {
                        controller.abandonPending();
                        Navigator.pop(context, false);
                      },
                child: const Text('Giữ tên máy chủ'),
              ),
            if (!unavailable)
              FilledButton(
                onPressed: !canSave
                    ? null
                    : checking
                    ? _check
                    : () => _save(reviewing ? snapshot : null),
                child: Text(
                  checking
                      ? 'Kiểm tra lại'
                      : reviewing
                      ? 'Xác nhận lưu'
                      : 'Lưu',
                ),
              ),
          ],
        ),
      );
    },
  );
}
