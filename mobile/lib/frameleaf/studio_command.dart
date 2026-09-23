/// Native Studio command envelopes (FL-92, `STU-205`).
///
/// The native clients do not restate the Studio vocabulary: they read it from
/// [frameleafStudioCommands] in `studio_commands.g.dart`, which is generated from
/// `studio/frameleaf-studio-commands.json` by `scripts/frameleaf-studio-commands.mjs`
/// together with the web vocabulary and the server mirror. A command the tablet can send
/// is therefore exactly a command the web host can send and the server will validate.
///
/// This file adds the envelope around a command and the local checks worth doing before a
/// request leaves the device: the id is published, the required fields are present, the
/// present fields have the declared kind, and no unknown field is smuggled in. The server
/// repeats all of it; nothing here is a substitute for its authorization, lease and
/// revision rules, and none of these commands is implemented yet — the server answers
/// `not-implemented` until the owning story lands.
///
/// A payload field typed `time`, `duration` or `rate` is an exact rational (FL-93): an
/// instant, a length, or a cadence or speed multiplier. It travels as the reduced integer
/// pair `{"num": .., "den": ..}` and is modelled natively by [FrameleafStudioRational],
/// never by a double — 1001/30000 has no double spelling, so a phone that rounded it would
/// hand the encoder a boundary the person never set.
///
/// Payload values whose declared type is `object` or `object[]` are carried through
/// unread, so unknown graph fields, nulls, arrays and rational timing extensions survive
/// the round trip without a lossy native projection.
library;

import 'studio_commands.g.dart';

/// Why a locally built envelope was refused before it was sent.
enum FrameleafStudioCommandProblem {
  unknownCommand,
  missingField,
  wrongFieldType,
  unknownField,
  invalidEnvelope,
}

class FrameleafStudioCommandError implements Exception {
  const FrameleafStudioCommandError(this.problem, this.detail);

  final FrameleafStudioCommandProblem problem;
  final String detail;

  @override
  String toString() => 'FrameleafStudioCommandError(${problem.name}): $detail';
}

/// The longest idempotency key the web host and the server accept.
const int frameleafStudioIdempotencyKeyMaxLength = 128;

/// One command the editor wants applied, with everything the host needs to decide.
class FrameleafStudioCommandEnvelope {
  const FrameleafStudioCommandEnvelope({
    required this.id,
    required this.payload,
    required this.revision,
    required this.idempotencyKey,
    required this.issuedAt,
  });

  /// The published command id, for example `clip.trimStart`.
  final String id;

  /// Command intent. Graph-shaped values inside it are opaque and travel unread.
  final Map<String, dynamic> payload;

  /// The project revision the client believed it was editing.
  final int revision;

  /// Stable per attempt, so a retry after a dropped response cannot apply twice.
  final String idempotencyKey;

  /// Epoch milliseconds, for ordering within a batch and for diagnostics.
  final int issuedAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'id': id,
    'payload': payload,
    'revision': revision,
    'idempotencyKey': idempotencyKey,
    'issuedAt': issuedAt,
  };

  static FrameleafStudioCommandEnvelope fromJson(Map<String, dynamic> json) {
    final Object? payload = json['payload'];
    if (json['id'] is! String ||
        payload is! Map<String, dynamic> ||
        json['revision'] is! int ||
        json['idempotencyKey'] is! String ||
        json['issuedAt'] is! int) {
      throw const FrameleafStudioCommandError(
        FrameleafStudioCommandProblem.invalidEnvelope,
        'envelope is missing a required member',
      );
    }
    return FrameleafStudioCommandEnvelope(
      id: json['id'] as String,
      payload: payload,
      revision: json['revision'] as int,
      idempotencyKey: json['idempotencyKey'] as String,
      issuedAt: json['issuedAt'] as int,
    );
  }

  /// The catalogue row for this envelope, or null when the id is not published.
  FrameleafStudioCommand? get definition => frameleafStudioCommandsById[id];
}

/// A reduced integer pair, the way the web host and the server spell a rational.
bool _isRational(Object? value) {
  if (value is! Map) {
    return false;
  }
  final Object? numerator = value['num'];
  final Object? denominator = value['den'];
  if (numerator is! int || denominator is! int || denominator <= 0) {
    return false;
  }
  int a = numerator.abs();
  int b = denominator;
  while (b != 0) {
    final int next = a % b;
    a = b;
    b = next;
  }
  // Reduced, so equality is structural on both sides of the wire. Zero is 0/1.
  return a == 1 || (numerator == 0 && denominator == 1);
}

bool _matchesFieldType(String type, Object? value) {
  if (frameleafStudioRationalFieldTypes.contains(type)) {
    return _isRational(value);
  }
  switch (type) {
    case 'boolean':
      return value is bool;
    case 'number':
      return value is num && value.isFinite;
    case 'string':
      return value is String;
    case 'string[]':
      return value is List && value.every((Object? item) => item is String);
    case 'object':
      // Null is allowed: clearing a transition, a mask or a grade is a real command.
      return value == null || value is Map;
    case 'object[]':
      return value is List && value.every((Object? item) => item is Map);
    default:
      return false;
  }
}

/// Check an envelope against the published catalogue. Throws
/// [FrameleafStudioCommandError] with the first problem found.
void validateFrameleafStudioCommand(FrameleafStudioCommandEnvelope envelope) {
  final FrameleafStudioCommand? command = frameleafStudioCommandsById[envelope.id];
  if (command == null) {
    throw FrameleafStudioCommandError(
      FrameleafStudioCommandProblem.unknownCommand,
      'unknown command ${envelope.id}',
    );
  }
  if (envelope.revision < 0 ||
      envelope.idempotencyKey.isEmpty ||
      envelope.idempotencyKey.length > frameleafStudioIdempotencyKeyMaxLength) {
    throw const FrameleafStudioCommandError(
      FrameleafStudioCommandProblem.invalidEnvelope,
      'revision or idempotency key is out of range',
    );
  }

  final Set<String> declared = <String>{};
  for (final FrameleafStudioField field in command.payload) {
    declared.add(field.name);
    final bool present = envelope.payload.containsKey(field.name) && envelope.payload[field.name] != null;
    if (!present) {
      // A declared `object` field may legitimately be null, so an explicit null only
      // satisfies a field whose type accepts it.
      final bool explicitNull = envelope.payload.containsKey(field.name);
      if (explicitNull && _matchesFieldType(field.type, null)) {
        continue;
      }
      if (field.required) {
        throw FrameleafStudioCommandError(
          FrameleafStudioCommandProblem.missingField,
          '${envelope.id}: missing required field ${field.name}',
        );
      }
      continue;
    }
    if (!_matchesFieldType(field.type, envelope.payload[field.name])) {
      throw FrameleafStudioCommandError(
        FrameleafStudioCommandProblem.wrongFieldType,
        '${envelope.id}: field ${field.name} is not ${field.type}',
      );
    }
  }

  for (final String name in envelope.payload.keys) {
    if (!declared.contains(name)) {
      throw FrameleafStudioCommandError(
        FrameleafStudioCommandProblem.unknownField,
        '${envelope.id}: unknown field $name',
      );
    }
  }
}

/// True when any command in an ordered batch would change the stored graph, which is what
/// makes the batch need the write lease and the caller's revision.
bool frameleafStudioBatchMutatesGraph(List<FrameleafStudioCommandEnvelope> envelopes) =>
    envelopes.any((FrameleafStudioCommandEnvelope envelope) => envelope.definition?.mutatesGraph ?? false);

/// Read a rational payload field, or null when it is absent. Throws when the field is
/// present but is not a reduced integer pair, because a native caller that wants the value
/// must not silently receive a rounded one.
FrameleafStudioRational? frameleafStudioRationalField(
  FrameleafStudioCommandEnvelope envelope,
  String name,
) {
  final Object? value = envelope.payload[name];
  if (value == null) {
    return null;
  }
  if (!_isRational(value)) {
    throw FrameleafStudioCommandError(
      FrameleafStudioCommandProblem.wrongFieldType,
      '${envelope.id}: field $name is not an exact rational',
    );
  }
  return FrameleafStudioRational.fromJson(Map<String, dynamic>.from(value as Map));
}

/// Worker capabilities an ordered batch needs, with no duplicates.
Set<FrameleafStudioCapability> frameleafStudioBatchCapabilities(List<FrameleafStudioCommandEnvelope> envelopes) =>
    envelopes
        .map((FrameleafStudioCommandEnvelope envelope) => envelope.definition?.capability)
        .whereType<FrameleafStudioCapability>()
        .toSet();
