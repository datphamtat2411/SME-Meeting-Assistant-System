part of 'api_client.dart';

/// UUID value used by the authentication contracts instead of unchecked text.
@immutable
class AuthUuid {
  const AuthUuid._(this.value);

  static final RegExp _pattern = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  final String value;

  static AuthUuid parse(String value, {required ApiResult response}) {
    if (!_pattern.hasMatch(value)) invalidApiData(response: response);
    return AuthUuid._(value.toLowerCase());
  }

  @override
  bool operator ==(Object other) => other is AuthUuid && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => value;
}

enum AuthTokenType { bearer }

enum AuthGlobalRole { employee, departmentManager, administrator }

enum AuthAccountStatus { pendingSetup, active, inactive }

enum AuthClientType { web, mobile }

@immutable
class AuthTokenResponse {
  const AuthTokenResponse._({
    required this.accessToken,
    required this.refreshToken,
    required this.tokenType,
    required this.expiresIn,
  });

  final String accessToken;
  final String refreshToken;
  final AuthTokenType tokenType;
  final int expiresIn;

  static final RegExp _base64UrlSegment = RegExp(r'^[A-Za-z0-9_-]+$');
  static final RegExp _opaqueRefreshToken = RegExp(r'^[A-Za-z0-9_-]+$');

  factory AuthTokenResponse.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
  }) {
    final accessToken = requiredString(
      raw,
      'accessToken',
      response: response,
      nonEmpty: true,
    );
    final refreshToken = requiredString(
      raw,
      'refreshToken',
      response: response,
      nonEmpty: true,
    );
    if (!_isAccessToken(accessToken) ||
        !_opaqueRefreshToken.hasMatch(refreshToken)) {
      invalidApiData(response: response);
    }

    final rawTokenType = requiredString(
      raw,
      'tokenType',
      response: response,
      nonEmpty: true,
    );
    if (rawTokenType != 'Bearer') invalidApiData(response: response);

    final expiresIn = requiredInt(
      raw,
      'expiresIn',
      response: response,
      minimum: 1,
    );
    return AuthTokenResponse._(
      accessToken: accessToken,
      refreshToken: refreshToken,
      tokenType: AuthTokenType.bearer,
      expiresIn: expiresIn,
    );
  }

  static bool _isAccessToken(String value) {
    final segments = value.split('.');
    return segments.length == 3 && segments.every(_base64UrlSegment.hasMatch);
  }
}

@immutable
class DirectoryManagementScope {
  DirectoryManagementScope._({
    required this.allUnits,
    required List<AuthUuid> unitIds,
  }) : unitIds = List<AuthUuid>.unmodifiable(unitIds);

  final bool allUnits;
  final List<AuthUuid> unitIds;

  factory DirectoryManagementScope.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
  }) {
    final allUnits = requiredBool(raw, 'allUnits', response: response);
    final rawUnitIds = raw['unitIds'];
    if (!raw.containsKey('unitIds') || rawUnitIds is! List) {
      invalidApiData(response: response);
    }
    final unitIds = <AuthUuid>[];
    final seen = <AuthUuid>{};
    for (final rawUnitId in rawUnitIds) {
      if (rawUnitId is! String) invalidApiData(response: response);
      final unitId = AuthUuid.parse(rawUnitId, response: response);
      if (!seen.add(unitId)) invalidApiData(response: response);
      unitIds.add(unitId);
    }
    return DirectoryManagementScope._(allUnits: allUnits, unitIds: unitIds);
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'allUnits': allUnits,
    'unitIds': List<String>.unmodifiable(unitIds.map((unitId) => unitId.value)),
  };
}

@immutable
class AuthSessionContext {
  const AuthSessionContext._({
    required this.id,
    required this.clientType,
    required this.createdAt,
    required this.lastSeenAt,
    required this.absoluteExpiresAt,
  });

  final AuthUuid id;
  final AuthClientType clientType;
  final DateTime createdAt;
  final DateTime? lastSeenAt;
  final DateTime absoluteExpiresAt;

  factory AuthSessionContext.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
  }) {
    final id = AuthUuid.parse(
      requiredIdentifier(raw, 'id', response: response),
      response: response,
    );
    final clientType = _clientTypeFromJson(
      requiredString(raw, 'clientType', response: response, nonEmpty: true),
      response,
    );
    final createdAt = requiredTimestamp(raw, 'createdAt', response: response);
    if (!raw.containsKey('lastSeenAt')) invalidApiData(response: response);
    final lastSeenAt = optionalTimestamp(raw, 'lastSeenAt', response: response);
    final absoluteExpiresAt = requiredTimestamp(
      raw,
      'absoluteExpiresAt',
      response: response,
    );
    if (!absoluteExpiresAt.isAfter(createdAt) ||
        (lastSeenAt != null &&
            (lastSeenAt.isBefore(createdAt) ||
                !lastSeenAt.isBefore(absoluteExpiresAt)))) {
      invalidApiData(response: response);
    }
    return AuthSessionContext._(
      id: id,
      clientType: clientType,
      createdAt: createdAt,
      lastSeenAt: lastSeenAt,
      absoluteExpiresAt: absoluteExpiresAt,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'id': id.value,
    'clientType': _clientTypeName(clientType),
    'createdAt': createdAt.toIso8601String(),
    'lastSeenAt': lastSeenAt?.toIso8601String(),
    'absoluteExpiresAt': absoluteExpiresAt.toIso8601String(),
  };
}

@immutable
class AuthIdentity {
  const AuthIdentity._({
    required this.userId,
    required this.email,
    required this.displayName,
    required this.globalRole,
    required this.accountStatus,
    required this.primaryOrgUnitId,
    required this.directoryManagementScope,
    required this.session,
  });

  final AuthUuid userId;
  final String email;
  final String displayName;
  final AuthGlobalRole globalRole;
  final AuthAccountStatus accountStatus;
  final AuthUuid? primaryOrgUnitId;
  final DirectoryManagementScope directoryManagementScope;
  final AuthSessionContext session;

  bool get isEligibleMobileIdentity =>
      accountStatus == AuthAccountStatus.active &&
      session.clientType == AuthClientType.mobile;

  factory AuthIdentity.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
  }) {
    final userId = AuthUuid.parse(
      requiredIdentifier(raw, 'userId', response: response),
      response: response,
    );
    final email = requiredString(
      raw,
      'email',
      response: response,
      nonEmpty: true,
    );
    final displayName = requiredString(
      raw,
      'displayName',
      response: response,
      nonEmpty: true,
    );
    final globalRole = _globalRoleFromJson(
      requiredString(raw, 'globalRole', response: response, nonEmpty: true),
      response,
    );
    final accountStatus = _accountStatusFromJson(
      requiredString(raw, 'accountStatus', response: response, nonEmpty: true),
      response,
    );
    if (!raw.containsKey('primaryOrgUnitId')) {
      invalidApiData(response: response);
    }
    final rawPrimaryOrgUnitId = raw['primaryOrgUnitId'];
    final AuthUuid? primaryOrgUnitId;
    if (rawPrimaryOrgUnitId == null) {
      primaryOrgUnitId = null;
    } else if (rawPrimaryOrgUnitId is String) {
      primaryOrgUnitId = AuthUuid.parse(
        rawPrimaryOrgUnitId,
        response: response,
      );
    } else {
      invalidApiData(response: response);
    }

    final scope = DirectoryManagementScope.fromJson(
      requiredObject(raw, 'directoryManagementScope', response: response),
      response: response,
    );
    final session = AuthSessionContext.fromJson(
      requiredObject(raw, 'session', response: response),
      response: response,
    );
    return AuthIdentity._(
      userId: userId,
      email: email,
      displayName: displayName,
      globalRole: globalRole,
      accountStatus: accountStatus,
      primaryOrgUnitId: primaryOrgUnitId,
      directoryManagementScope: scope,
      session: session,
    );
  }

  /// Read-only projection for established feature consumers of ApiClient.
  Map<String, dynamic> toCompatibilityMap() =>
      Map<String, dynamic>.unmodifiable(<String, dynamic>{
        'userId': userId.value,
        'email': email,
        'displayName': displayName,
        'globalRole': _globalRoleName(globalRole),
        'accountStatus': _accountStatusName(accountStatus),
        'primaryOrgUnitId': primaryOrgUnitId?.value,
        'directoryManagementScope': Map<String, dynamic>.unmodifiable(
          directoryManagementScope.toJson(),
        ),
        'session': Map<String, dynamic>.unmodifiable(session.toJson()),
      });
}

AuthGlobalRole _globalRoleFromJson(String value, ApiResult response) =>
    switch (value) {
      'EMPLOYEE' => AuthGlobalRole.employee,
      'DEPARTMENT_MANAGER' => AuthGlobalRole.departmentManager,
      'ADMINISTRATOR' => AuthGlobalRole.administrator,
      _ => _invalidRole(response),
    };

AuthAccountStatus _accountStatusFromJson(String value, ApiResult response) =>
    switch (value) {
      'PENDING_SETUP' => AuthAccountStatus.pendingSetup,
      'ACTIVE' => AuthAccountStatus.active,
      'INACTIVE' => AuthAccountStatus.inactive,
      _ => _invalidAccountStatus(response),
    };

AuthClientType _clientTypeFromJson(String value, ApiResult response) =>
    switch (value) {
      'WEB' => AuthClientType.web,
      'MOBILE' => AuthClientType.mobile,
      _ => _invalidClientType(response),
    };

Never _invalidRole(ApiResult response) => invalidApiData(response: response);

Never _invalidAccountStatus(ApiResult response) =>
    invalidApiData(response: response);

Never _invalidClientType(ApiResult response) =>
    invalidApiData(response: response);

String _globalRoleName(AuthGlobalRole value) => switch (value) {
  AuthGlobalRole.employee => 'EMPLOYEE',
  AuthGlobalRole.departmentManager => 'DEPARTMENT_MANAGER',
  AuthGlobalRole.administrator => 'ADMINISTRATOR',
};

String _accountStatusName(AuthAccountStatus value) => switch (value) {
  AuthAccountStatus.pendingSetup => 'PENDING_SETUP',
  AuthAccountStatus.active => 'ACTIVE',
  AuthAccountStatus.inactive => 'INACTIVE',
};

String _clientTypeName(AuthClientType value) => switch (value) {
  AuthClientType.web => 'WEB',
  AuthClientType.mobile => 'MOBILE',
};
