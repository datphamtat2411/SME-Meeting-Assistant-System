import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class RecordingPage extends StatefulWidget {
  final ApiClient api;
  final String meetingId;
  final bool enabled;
  const RecordingPage({super.key, required this.api, required this.meetingId,
    required this.enabled});

  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage> {
  final AudioRecorder recorder = AudioRecorder();
  bool capturing = false;
  bool busy = false;
  File? file;
  String? selectedName;
  String sourceType = 'UPLOAD';
  int elapsed = 0;
  Timer? timer;
  ProcessingJob? job;
  late Future<List<ProcessingJob>> jobs;

  @override
  void initState() {
    super.initState();
    reloadJobs();
  }

  void reloadJobs() => setState(() {
    jobs = widget.api.get('/meetings/' + widget.meetingId + '/processing-jobs')
      .then((value) => objectsOf(value.data).map(ProcessingJob.new).toList());
  });

  @override
  void dispose() {
    timer?.cancel();
    if (capturing) unawaited(recorder.stop());
    unawaited(recorder.dispose());
    super.dispose();
  }

  Future<void> begin() async {
    if (!widget.enabled || busy || capturing) return;
    try {
      if (!await recorder.hasPermission()) {
        throw const ApiFailure(0, 'MIC_PERMISSION', 'Cần quyền micro để ghi âm.');
      }
      final folder = await getApplicationDocumentsDirectory();
      final path = folder.path + '/sme-meeting-' +
          DateTime.now().millisecondsSinceEpoch.toString() + '.wav';
      await recorder.start(const RecordConfig(
        encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1), path: path);
      timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() => elapsed++);
      });
      if (mounted) setState(() {
        capturing = true; elapsed = 0; file = null; selectedName = null;
        job = null; sourceType = 'RECORDING';
      });
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> stop() async {
    timer?.cancel();
    try {
      final path = await recorder.stop();
      if (mounted) setState(() {
        capturing = false;
        file = path == null ? null : File(path);
        selectedName = path == null ? null : File(path).uri.pathSegments.last;
        sourceType = 'RECORDING';
      });
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> pick() async {
    try {
      final result = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: ['mp3', 'wav', 'm4a']);
      if (result == null) return;
      File selected;
      if (result.path != null) {
        selected = File(result.path!);
      } else {
        // SAF/cloud documents may not expose a local path. Stream into the
        // app sandbox without buffering potentially large meeting audio.
        final folder = await getTemporaryDirectory();
        final safeName = result.name.replaceAll(RegExp(r'[^A-Za-z0-9_.-]'), '_');
        selected = File(folder.path +
          '/sme-import-${DateTime.now().microsecondsSinceEpoch}-$safeName');
        final sink = selected.openWrite();
        try {
          await sink.addStream(result.readAsByteStream());
        } catch (_) {
          await sink.close();
          if (await selected.exists()) await selected.delete();
          rethrow;
        }
        await sink.close();
      }
      if (mounted) {
        setState(() {
          file = selected;
          selectedName = result.name;
          sourceType = 'UPLOAD';
          job = null;
        });
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  String contentType(File selected) {
    final name = (selectedName ?? selected.path).toLowerCase();
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    if (name.endsWith('.m4a')) return 'audio/mp4';
    return 'audio/wav';
  }

  String key() {
    final bytes = List<int>.generate(16, (_) => Random.secure().nextInt(256));
    return bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  }

  Future<void> upload() async {
    final selected = file;
    if (selected == null || busy) return;
    setState(() => busy = true);
    try {
      final size = await selected.length();
      if (size == 0) throw const ApiFailure(422, 'EMPTY_AUDIO', 'File ghi âm trống.');
      final mime = contentType(selected);
      final path = '/meetings/' + widget.meetingId;
      final intent = objectOf((await widget.api.post(
        path + '/media/uploads',
        {
          'sourceType': sourceType,
          'originalFilename': selectedName ?? selected.uri.pathSegments.last,
          'contentType': mime,
          'expectedSizeBytes': size,
        },
        headers: {'Idempotency-Key': key()},
      )).data);
      final mediaId = textValue(intent['mediaId']);
      final signedUrl = textValue(intent['uploadUrl']);
      if (mediaId.isEmpty || signedUrl.isEmpty) {
        throw const ApiFailure(0, 'INVALID_UPLOAD', 'Server did not provide upload capability.');
      }
      await widget.api.uploadSigned(signedUrl, selected,
        textValue(intent['requiredContentType'], mime));
      final finalized = objectOf(
        (await widget.api.post(path + '/media/' + mediaId + '/finalize', {})).data);
      if (textValue(finalized['status']) != 'AVAILABLE') {
        throw const ApiFailure(409, 'MEDIA_NOT_AVAILABLE', 'Media has not been accepted.');
      }
      final accepted = objectOf((await widget.api.post(
        path + '/processing-jobs', {'mediaId': mediaId},
        headers: {'Idempotency-Key': key()},
      )).data);
      if (mounted) {
        setState(() => job = ProcessingJob(accepted));
        showSuccess(context, 'Đã gửi ghi âm. AI đang xử lý bất đồng bộ.');
        reloadJobs();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> retryJob(ProcessingJob candidate) async {
    setState(() => busy = true);
    try {
      final response = await widget.api.post(
        '/processing-jobs/' + candidate.id + '/retry', {},
        headers: {'Idempotency-Key': key()});
      if (mounted) {
        setState(() => job = ProcessingJob(objectOf(response.data)));
        reloadJobs();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      const SectionHeading('Ghi âm và tải lên',
        subtitle: 'Âm thanh chỉ được xử lý sau khi gửi hoàn tất.'),
      if (!widget.enabled) const MessagePanel(
        title: 'Không thể ghi âm cuộc họp đã hủy'),
      ContentCard(child: Column(children: [
        CircleAvatar(radius: 38,
          backgroundColor: capturing ? Palette.red.withValues(alpha: 0.1) : Palette.surface,
          child: Icon(capturing ? Icons.mic : Icons.mic_none,
            size: 34, color: capturing ? Palette.red : Palette.ink)),
        const SizedBox(height: 12),
        Text(capturing ? 'Đang ghi âm · ' +
          Duration(seconds: elapsed).toString().split('.').first
          : 'Ghi âm cuộc họp',
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        const SizedBox(height: 12),
        if (capturing) FilledButton.icon(
          onPressed: stop, icon: const Icon(Icons.stop), label: const Text('Dừng ghi âm'))
        else FilledButton.icon(
          onPressed: widget.enabled && !busy ? begin : null,
          icon: const Icon(Icons.mic), label: const Text('Bắt đầu ghi âm')),
        const SizedBox(height: 8),
        OutlinedButton.icon(onPressed: capturing || busy || !widget.enabled ? null : pick,
          icon: const Icon(Icons.upload_file), label: const Text('Chọn file MP3 / WAV / M4A')),
      ])),
      if (file != null) ContentCard(child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(selectedName ?? file!.uri.pathSegments.last, maxLines: 2,
            style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: busy ? null : upload,
            icon: const Icon(Icons.cloud_upload_outlined),
            label: Text(busy ? 'Đang tải lên...' : 'Tải lên và xử lý AI')),
          const SizedBox(height: 6),
          const Text('File nguồn vẫn giữ lại trên thiết bị khi upload lỗi.',
            style: TextStyle(color: Palette.muted, fontSize: 12)),
        ])),
      if (job != null) jobTile(job!),
      SectionHeading('Tiến trình xử lý', trailing: IconButton(
        onPressed: reloadJobs, icon: const Icon(Icons.refresh))),
      AsyncContent<List<ProcessingJob>>(
        future: jobs, retry: reloadJobs,
        builder: (values) => Column(children: [
          if (values.isEmpty) const MessagePanel(title: 'Chưa có lần xử lý nào'),
          ...values.map(jobTile),
        ])),
    ],
  );

  Widget jobTile(ProcessingJob item) => ContentCard(child: Column(
    crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        const Icon(Icons.auto_awesome, color: Palette.blue),
        const SizedBox(width: 8),
        Expanded(child: Text(item.stage.isEmpty ? 'Xử lý cuộc họp' : item.stage,
          style: const TextStyle(fontWeight: FontWeight.w700))),
        StatePill(item.status),
      ]),
      if (item.warning.isNotEmpty) Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(item.warning, style: const TextStyle(color: Palette.amber))),
      if (item.error.isNotEmpty) Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(item.error, style: const TextStyle(color: Palette.red))),
      if (item.retryable) Align(alignment: Alignment.centerRight,
        child: TextButton(onPressed: busy ? null : () => retryJob(item),
          child: const Text('Thử lại'))),
    ]));
}
