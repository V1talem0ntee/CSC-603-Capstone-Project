(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Personalization = factory();
})(globalThis, function () {
  function validate(input) {
    const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Please provide your Travel DNA profile.');
    const profile = input.profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.profile_type !== 'travel_dna' || profile.schema_version !== '1.0') {
      fail('Please provide a Travel DNA JSON object with schema_version 1.0 and profile_type travel_dna.');
    }
    if (JSON.stringify(profile).length > 30000) fail('The profile is too large. Please keep it under 30,000 characters.');
    return { profile };
  }

  return { validate };
});
