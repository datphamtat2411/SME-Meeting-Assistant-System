import 'package:sme_meeting_assistant/core/api_client.dart';

/// A detail-scoped lease for one version-sensitive aggregate operation.
///
/// Tokens are identity checked by their issuing detail controller; constructing
/// another token with the same fields does not grant ownership.
class MeetingAggregateMutationToken {
  const MeetingAggregateMutationToken({
    required this.meetingId,
    required this.sessionScope,
    required this.sequence,
    required this.invalidationRevision,
  });

  final String meetingId;
  final AuthenticatedSessionScope sessionScope;
  final int sequence;
  final int invalidationRevision;
}
