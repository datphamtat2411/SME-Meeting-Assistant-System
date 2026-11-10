import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/meeting_models.dart';
import '../../core/models.dart';

class RoomAvailabilityField extends StatefulWidget {
  const RoomAvailabilityField({
    super.key, required this.api, required this.start, required this.end,
    required this.selectedId, required this.onChanged,
    this.participantCount,
  });
  final ApiClient api;
  final DateTime start, end;
  final String? selectedId;
  final int? participantCount;
  final ValueChanged<String?> onChanged;

  @override
  State<RoomAvailabilityField> createState() => _RoomAvailabilityFieldState();
}

class _RoomAvailabilityFieldState extends State<RoomAvailabilityField> {
  late Future<List<Map<String, dynamic>>> _rooms;

  @override
  void initState() { super.initState(); _load(); }

  @override
  void didUpdateWidget(covariant RoomAvailabilityField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.start != widget.start || oldWidget.end != widget.end ||
        oldWidget.participantCount != widget.participantCount) _load();
  }

  void _load() {
    if (!widget.end.isAfter(widget.start)) {
      _rooms = Future.value([]);
      return;
    }
    _rooms = widget.api.get('/rooms/availability', query: {
      'start': dateIso(widget.start),
      'end': dateIso(widget.end),
      'size': '100',
      if (widget.participantCount != null)
        'participantCount': widget.participantCount.toString(),
    }).then((r) => objectsOf(r.data));
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<List<Map<String, dynamic>>>(
    future: _rooms,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Không thể kiểm tra tình trạng phòng.'),
          TextButton.icon(onPressed: () => setState(_load),
            icon: const Icon(Icons.refresh), label: const Text('Thử lại')),
        ]);
      }
      if (!snapshot.hasData) return const LinearProgressIndicator();
      final rooms = snapshot.data!;
      final matching = rooms.where((r) => r['id'] == widget.selectedId).toList();
      // A scheduled meeting can occupy its own room; keep it selectable,
      // but show a clear advisory warning instead of silently clearing it.
      final validId = widget.selectedId == null ||
          matching.isNotEmpty ? widget.selectedId : null;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DropdownButtonFormField<String>(
          key: ValueKey(validId),
          initialValue: validId ?? '',
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Phòng họp'),
          items: [
            const DropdownMenuItem(value: '', child: Text('Không sử dụng phòng')),
            ...rooms.map((r) {
              final room = MeetingRoom.fromJson(r);
              final available = r['available'] == true;
              final isSelected = room.id == widget.selectedId;
              return DropdownMenuItem(
                value: room.id,
                enabled: available || isSelected,
                child: Text(room.name + (available ? ' · Trống' : ' · Bận'),
                  overflow: TextOverflow.ellipsis),
              );
            }),
          ],
          onChanged: (value) => widget.onChanged(value == '' ? null : value),
        ),
        if (matching.isNotEmpty && matching.first['available'] != true)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('Phòng có lịch trùng; máy chủ sẽ kiểm tra lại khi lưu.',
              style: TextStyle(fontSize: 12)),
          ),
      ]);
    },
  );
}
