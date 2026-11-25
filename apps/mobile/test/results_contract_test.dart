import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';

void main() {
  test('keeps item and header concurrency tokens opaque', () {
    final response = ApiResult(
      {
        'id': 'summary-1',
        'meetingId': 'meeting-1',
        'versionNumber': 2,
        'content': 'Summary',
        'sourceType': 'HUMAN_EDIT',
        'qualityStatus': 'CONFIRMED',
        'processingJobId': null,
        'transcriptId': null,
        'contentRevision': null,
        'isStale': false,
        'createdAt': '2026-11-23T10:00:00Z',
        'createdByUserId': 'user-1',
        'aiWarnings': <String>[],
      },
      const {},
      '"sum-server-token"',
    );

    final summary = ResultsSummary.fromResult(response);

    expect(summary.etag, '"sum-server-token"');
    expect(summary.versionNumber, 2);
  });

  test('rejects a summary response without its server token', () {
    expect(
      () => ResultsSummary.fromResult(
        ApiResult(
          {
            'id': 'summary-1',
            'meetingId': 'meeting-1',
            'versionNumber': 2,
            'content': 'Summary',
            'sourceType': 'HUMAN_EDIT',
            'qualityStatus': 'CONFIRMED',
            'processingJobId': null,
            'transcriptId': null,
            'contentRevision': null,
            'isStale': false,
            'createdAt': '2026-11-23T10:00:00Z',
            'createdByUserId': 'user-1',
            'aiWarnings': <String>[],
          },
          const {},
          null,
        ),
      ),
      throwsA(isA<ApiFailure>()),
    );
  });

  test('parses item-level tokens for transcript segments and decisions', () {
    final segment = SpeechSegment.fromJson({
      'id': 'segment-1',
      'ordinal': 0,
      'startMs': 0,
      'endMs': 1000,
      'text': 'Hello',
      'qualityStatus': 'ACCEPTED',
      'speakerClusterId': null,
      'speakerLabel': null,
      'version': 4,
      'etag': '"s-server-token"',
    });
    final decision = MeetingDecision.fromJson({
      'id': 'decision-1',
      'meetingId': 'meeting-1',
      'content': 'Decision',
      'status': 'CONFIRMED',
      'version': 4,
      'isStale': false,
      'createdAt': '2026-11-23T10:00:00Z',
      'confirmedAt': null,
      'rejectedAt': null,
      'etag': '"dec-server-token"',
    });

    expect(segment.etag, '"s-server-token"');
    expect(decision.etag, '"dec-server-token"');
  });
}
