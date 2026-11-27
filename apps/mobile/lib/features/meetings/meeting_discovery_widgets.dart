import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';

class MeetingProjectionCard extends StatelessWidget {
  const MeetingProjectionCard({
    super.key,
    required this.projection,
    required this.onTap,
  });

  final MeetingListProjection projection;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final meeting = projection.meeting;
    final display = projection.display;
    return ContentCard(
      padding: EdgeInsets.zero,
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      meeting.title,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  StatePill(meeting.status),
                ],
              ),
              if (meeting.description?.isNotEmpty == true)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    meeting.description!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Palette.muted),
                  ),
                ),
              const SizedBox(height: 12),
              _detailLine(
                Icons.schedule_outlined,
                dateLabel(meeting.scheduledStartAt),
              ),
              if (display.roomName != null)
                _detailLine(
                  Icons.meeting_room_outlined,
                  display.roomLocation == null
                      ? display.roomName!
                      : '${display.roomName} · ${display.roomLocation}',
                ),
              _detailLine(
                Icons.person_outline,
                '${display.organizerName ?? 'Người tổ chức'} · ${display.participantCount} người tham gia',
              ),
              if (display.participantPreview.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: display.participantPreview
                        .map(
                          (participant) => Chip(
                            visualDensity: VisualDensity.compact,
                            label: Text(
                              participant.displayName ?? 'Thành viên',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _detailLine(IconData icon, String label) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Row(
      children: [
        Icon(icon, size: 16, color: Palette.muted),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            label,
            style: const TextStyle(fontSize: 12, color: Palette.muted),
          ),
        ),
      ],
    ),
  );
}
