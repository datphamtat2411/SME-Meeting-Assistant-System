import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';

void main() {
  test('forbidden resource cannot retain previous protected data', () {
    const resource = ResultsResource<String>(
      phase: ResultsResourcePhase.available,
      data: 'protected',
    );
    final denied = resource.copyWith(phase: ResultsResourcePhase.forbidden);
    expect(denied.data, isNull);
    expect(denied.hasData, isFalse);
  });

  test('empty collection remains a reusable loaded resource', () {
    const resource = ResultsResource<List<String>>(
      phase: ResultsResourcePhase.empty, data: [],
    );
    expect(resource.hasData, isTrue);
  });

  test('canonical minutes can exist without a transcript', () {
    final minutes = MeetingMinutes.fromResult(ApiResult({
      'completeness': 'PARTIAL',
      'meeting': {'id': 'meeting-1'},
      'schemaVersion': 1,
      'sourceFingerprint': 'server-fingerprint',
      'assembledAt': '2026-11-23T10:00:00Z',
      'summary': null,
      'confirmedDecisions': <dynamic>[],
      'officialActionItems': <dynamic>[],
      'transcript': {'availability': 'NOT_AVAILABLE', 'status': null},
      'warnings': <String>[],
    }, const {}, null));
    expect(minutes.transcriptStatus, isNull);
    expect(minutes.transcriptAvailability, 'NOT_AVAILABLE');
  });


  test('older item representations remain read-only without a token', () {
    final segment = SpeechSegment.fromJson({
      'id': 'segment-1', 'ordinal': 0, 'startMs': 0, 'endMs': 1000,
      'text': 'Hello', 'qualityStatus': 'ACCEPTED', 'version': 0,
    });
    expect(segment.etag, isNull);
  });

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
