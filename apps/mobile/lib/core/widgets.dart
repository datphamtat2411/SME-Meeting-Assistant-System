import 'package:flutter/material.dart';

import 'api_client.dart';
import 'app_theme.dart';
import 'models.dart';

class SectionHeading extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget? trailing;
  const SectionHeading(this.title, {super.key, this.subtitle, this.trailing});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 14, top: 4),
    child: Row(children: [
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        if (subtitle != null) Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(subtitle!, style: const TextStyle(color: Palette.muted))),
      ])),
      if (trailing != null) trailing!,
    ]),
  );
}

class ContentCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const ContentCard({super.key, required this.child, this.padding = const EdgeInsets.all(16)});

  @override
  Widget build(BuildContext context) =>
      Card(margin: const EdgeInsets.only(bottom: 12),
        child: Padding(padding: padding, child: child));
}

class StatePill extends StatelessWidget {
  final String status;
  final String? label;
  const StatePill(this.status, {super.key, this.label});

  @override
  Widget build(BuildContext context) {
    final good = ['DONE', 'COMPLETED', 'ENDED', 'CONFIRMED', 'READY'].contains(status);
    final active = ['IN_PROGRESS', 'PROCESSING', 'SCHEDULED'].contains(status);
    final warn = ['PROPOSED', 'QUEUED', 'COMPLETED_WITH_WARNINGS', 'DRAFT'].contains(status);
    final tone = good ? Palette.green : active ? Palette.blue : warn ? Palette.amber : Palette.red;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.09),
        border: Border.all(color: tone.withValues(alpha: 0.22)),
        borderRadius: BorderRadius.circular(30)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        child: Text(label ?? meetingStates[status] ?? actionStates[status] ?? status,
          style: TextStyle(color: tone, fontSize: 11, fontWeight: FontWeight.w700)),
      ),
    );
  }
}

class MessagePanel extends StatelessWidget {
  final String title;
  final String? description;
  final IconData icon;
  final VoidCallback? onRetry;
  const MessagePanel({super.key, required this.title, this.description,
    this.icon = Icons.info_outline, this.onRetry});

  @override
  Widget build(BuildContext context) => ContentCard(
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 32, color: Palette.muted),
        const SizedBox(height: 12),
        Text(title, textAlign: TextAlign.center,
          style: const TextStyle(fontWeight: FontWeight.w700)),
        if (description != null) Padding(
          padding: const EdgeInsets.only(top: 6, bottom: 8),
          child: Text(description!, textAlign: TextAlign.center,
            style: const TextStyle(color: Palette.muted))),
        if (onRetry != null) TextButton.icon(
          onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Thử lại')),
      ]),
    ),
  );
}

class AsyncContent<T> extends StatelessWidget {
  final Future<T> future;
  final Widget Function(T value) builder;
  final VoidCallback? retry;
  const AsyncContent({super.key, required this.future, required this.builder, this.retry});

  @override
  Widget build(BuildContext context) => FutureBuilder<T>(
    future: future,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Center(child: Padding(
          padding: EdgeInsets.all(36), child: CircularProgressIndicator()));
      }
      if (snapshot.hasError) {
        return MessagePanel(
          icon: Icons.cloud_off_outlined,
          title: 'Không thể tải dữ liệu',
          description: snapshot.error is ApiFailure
              ? (snapshot.error as ApiFailure).message : 'Đã xảy ra lỗi không mong muốn.',
          onRetry: retry,
        );
      }
      if (!snapshot.hasData) return const MessagePanel(title: 'Không có dữ liệu');
      return builder(snapshot.data as T);
    },
  );
}

void showFailure(BuildContext context, Object error) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
    content: Text(error is ApiFailure ? error.message : 'Thao tác không thành công.')));
}

void showSuccess(BuildContext context, String message) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}
