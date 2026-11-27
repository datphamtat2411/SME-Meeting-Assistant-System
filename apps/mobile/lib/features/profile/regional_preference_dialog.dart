import 'package:flutter/material.dart';

import 'account_resource_view.dart';
import 'profile_controllers.dart';
import 'profile_models.dart';

enum RegionalSelectionKind { cancel, set, clear }

class RegionalSelection {
  const RegionalSelection.cancel()
    : kind = RegionalSelectionKind.cancel,
      value = null;
  const RegionalSelection.set(String identifier)
    : kind = RegionalSelectionKind.set,
      value = identifier;
  const RegionalSelection.clear()
    : kind = RegionalSelectionKind.clear,
      value = null;

  final RegionalSelectionKind kind;
  final String? value;
}

class RegionalPreferenceDialog extends StatefulWidget {
  const RegionalPreferenceDialog({
    super.key,
    required this.controller,
    required this.original,
    required this.field,
    required this.title,
    required this.options,
  });

  final PreferencesController controller;
  final PreferencesSnapshot original;
  final PreferenceField field;
  final String title;
  final Map<String, String> options;

  @override
  State<RegionalPreferenceDialog> createState() =>
      _RegionalPreferenceDialogState();
}

class _RegionalPreferenceDialogState extends State<RegionalPreferenceDialog> {
  late final TextEditingController _identifier;
  String _query = '';
  bool _clear = false;
  bool _submitting = false;
  String? _validation;

  PreferencesController get controller => widget.controller;
  bool get _timezone => widget.field == PreferenceField.timezone;
  String? _valueIn(PreferencesSnapshot snapshot) =>
      _timezone ? snapshot.preferences.timezone : snapshot.preferences.locale;

  @override
  void initState() {
    super.initState();
    final pending = controller.pendingIntent;
    final ownsPending = pending != null && pending.field == widget.field;
    final value = pending != null && pending.field == widget.field
        ? pending.value as String?
        : _valueIn(widget.original);
    _clear = ownsPending && value == null;
    _identifier = TextEditingController(text: value ?? '');
  }

  @override
  void dispose() {
    _identifier.dispose();
    super.dispose();
  }

  void _choose(String value) {
    setState(() {
      _identifier.text = value;
      _clear = false;
      _validation = null;
    });
  }

  void _chooseClear() {
    setState(() {
      _identifier.clear();
      _clear = true;
      _validation = null;
    });
  }

  RegionalSelection? _selection() {
    if (_clear) return const RegionalSelection.clear();
    final value = _identifier.text.trim();
    if (value.isEmpty ||
        value.length > (_timezone ? 64 : 32) ||
        RegExp(r'\s').hasMatch(value)) {
      setState(() {
        _validation = _timezone
            ? 'Nhập mã múi giờ hợp lệ, tối đa 64 ký tự.'
            : 'Nhập mã định dạng vùng hợp lệ, tối đa 32 ký tự.';
      });
      return null;
    }
    return RegionalSelection.set(value);
  }

  Future<void> _save() async {
    if (_submitting || !controller.current) return;
    final selection = _selection();
    if (selection == null || selection.kind == RegionalSelectionKind.cancel) {
      return;
    }
    setState(() {
      _validation = null;
      _submitting = true;
    });
    try {
      final saved = await controller.submitRegional(
        widget.field,
        selection.value,
        widget.original,
      );
      if (mounted && controller.current && saved) {
        Navigator.pop(context, selection);
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
          controller.pendingIntent == null) {
        Navigator.pop(context);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _confirm(Object? reviewedValue) async {
    if (_submitting || !controller.current) return;
    setState(() => _submitting = true);
    try {
      final saved = await controller.confirmPending(reviewedValue);
      if (mounted && controller.current && saved) Navigator.pop(context);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final snapshot = controller.snapshot;
      final unavailable = !controller.current || snapshot == null;
      final pending = controller.pendingIntent;
      final ownsPending = pending != null && pending.field == widget.field;
      final busy = _submitting || controller.saving;
      final editable =
          !busy &&
          !controller.loading &&
          pending == null &&
          !controller.needsReconciliation &&
          controller.current;
      final options = widget.options.entries.where(
        (entry) =>
            entry.key.toLowerCase().contains(_query) ||
            entry.value.toLowerCase().contains(_query),
      );
      return PopScope(
        canPop: !busy,
        child: AlertDialog(
          scrollable: true,
          title: Text(widget.title),
          content: !controller.current || snapshot == null
              ? const Text('Thiết lập không còn khả dụng.')
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${controller.needsReconciliation ? 'Lần xác nhận gần nhất' : 'Đã lưu'}: '
                      '${_valueIn(snapshot) ?? 'Chưa thiết lập'}',
                    ),
                    if (pending != null && pending.field == widget.field) ...[
                      const SizedBox(height: 8),
                      Text(
                        controller.needsReconciliation
                            ? 'Cần kiểm tra máy chủ trước khi thử lại.'
                            : 'Giá trị hiện tại khác với ý định đã chọn. Hãy xem lại trước khi xác nhận.',
                      ),
                      Text(
                        'Giá trị mong muốn: ${pending.value ?? 'Chưa thiết lập'}',
                      ),
                    ] else if (pending != null) ...[
                      const Text('Hãy xử lý thay đổi đang chờ trước.'),
                    ] else ...[
                      const SizedBox(height: 12),
                      TextField(
                        enabled: editable,
                        decoration: const InputDecoration(
                          labelText: 'Tìm lựa chọn phổ biến',
                          prefixIcon: Icon(Icons.search),
                        ),
                        onChanged: (value) =>
                            setState(() => _query = value.trim().toLowerCase()),
                      ),
                      for (final option in options)
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(option.value),
                          subtitle: Text(option.key),
                          selected: !_clear && _identifier.text == option.key,
                          trailing: !_clear && _identifier.text == option.key
                              ? const Icon(Icons.check)
                              : null,
                          onTap: editable ? () => _choose(option.key) : null,
                        ),
                      const Divider(),
                      TextField(
                        controller: _identifier,
                        enabled: editable,
                        decoration: InputDecoration(
                          labelText: _timezone
                              ? 'Mã múi giờ khác (IANA)'
                              : 'Mã định dạng vùng khác (BCP 47)',
                          hintText: _timezone ? 'Europe/Paris' : 'fr-CA',
                          errorText: _validation,
                        ),
                        onChanged: (_) => setState(() {
                          _clear = false;
                          _validation = null;
                        }),
                      ),
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        selected: _clear,
                        title: const Text('Xóa tùy chọn đã lưu'),
                        trailing: _clear ? const Icon(Icons.check) : null,
                        onTap: editable ? _chooseClear : null,
                      ),
                    ],
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
              onPressed: busy
                  ? null
                  : () => Navigator.pop(
                      context,
                      const RegionalSelection.cancel(),
                    ),
              child: Text(unavailable ? 'Đóng' : 'Hủy'),
            ),
            if (!unavailable && ownsPending && !controller.needsReconciliation)
              TextButton(
                onPressed: busy || controller.loading
                    ? null
                    : () {
                        controller.abandonPending();
                        Navigator.pop(context);
                      },
                child: const Text('Giữ giá trị máy chủ'),
              ),
            if (controller.current && snapshot != null && ownsPending)
              FilledButton(
                onPressed: busy
                    ? null
                    : controller.needsReconciliation
                    ? (controller.canRefresh ? _check : null)
                    : (controller.canConfirmPending
                          ? () => _confirm(_valueIn(snapshot))
                          : null),
                child: Text(
                  controller.needsReconciliation
                      ? 'Kiểm tra lại'
                      : 'Xác nhận lưu',
                ),
              )
            else if (!unavailable && pending == null)
              FilledButton(
                onPressed: editable && controller.canMutate ? _save : null,
                child: const Text('Lưu lựa chọn'),
              ),
          ],
        ),
      );
    },
  );
}
