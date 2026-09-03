/*
 * Company Profile Repository Module.
 *
 * Manages issuer company profiles: shipped built-in profiles, user-created
 * custom profiles in localStorage, branding asset overrides (logo/stamp),
 * atomic reset to shipped defaults with rollback, and image resizing.
 */

var CUSTOM_PROFILES_KEY = "preinvoice.companyProfiles.v1";
  var PROFILE_ASSETS_KEY = "preinvoice.profileAssets.v1";
  var PROFILE_OVERRIDES_KEY = "preinvoice.profileOverrides.v1";
  var CUSTOM_PROFILE_KEY = "other";
  var DEFAULT_PROFILE_KEY = "fouladBonyan";
  var BUILT_IN_PROFILE_ORDER = ["fouladBonyan", "karaBorjParseh"];

  var BUILT_IN_PROFILE_DEFAULTS = {
    fouladBonyan: {
      label: "بنیان فولاد داریا",
      logo: "assets/logo-foulad-bonyan-mark.png",
      stamp: "assets/stamp-foulad-bonyan.png",
      name: "بنیان فولاد داریا",
      nationalId: "۱۴۰۱۵۴۸۳۱۸۶",
      address: "تهران، آجودانیه، پورابتهاج، نبش لشکری، ساختمان سرو، واحد ۳۰۳",
      postalCode: "۱۹۷۸۹۷۷۱۹۸",
      phones: "۰۲۱-۸۸۸۸۸۲۸۰ / ۰۲۱-۸۸۸۸۸۷۸۰ / ۰۲۱-۸۸۸۸۸۱۲۲",
      website: "www.fouladbonyan.com",
    },
    karaBorjParseh: {
      label: "کارا برج پارسه",
      logo: "assets/logo-kara-borj-parseh.svg",
      stamp: "assets/stamp-kara-borj-parseh.png",
      name: "کارا برج پارسه",
      nationalId: "۱۴۰۰۷۴۳۲۹۹۹",
      address: "تهران، آجودانیه، پورابتهاج، نبش لشکری، ساختمان سرو، واحد ۳۰۳",
      postalCode: "۱۹۷۸۹۷۷۱۹۸",
      phones: "۰۲۱-۸۸۸۸۸۲۸۰ / ۰۲۱-۸۸۸۸۸۷۸۰ / ۰۲۱-۸۸۸۸۸۱۲۲",
      website: "www.karaborj.com",
    },
    other: {
      label: "سایر",
      logo: "",
      stamp: "",
      name: "",
      nationalId: "",
      address: "",
      postalCode: "",
      phones: "",
      website: "",
    },
  };

  var COMPANY_PROFILES = {};

  function readStoredObject(key) {
    if (typeof localStorage === "undefined") return {};
    try {
      var raw = localStorage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function isCustomProfile(key) {
    return key === CUSTOM_PROFILE_KEY;
  }

  function profileFromCompanyData(company, userCreated) {
    company = company || {};
    var name = String(company.name || company.label || "").trim();
    return {
      label: name,
      logo: String(company.logo || ""),
      stamp: String(company.stamp || ""),
      name: name,
      nationalId: String(company.nationalId || ""),
      address: String(company.address || ""),
      postalCode: String(company.postalCode || ""),
      phones: String(company.phones || company.phone || ""),
      website: String(company.website || ""),
      userCreated: !!userCreated,
    };
  }

  function hydrateCompanyProfiles() {
    COMPANY_PROFILES = {};
    Object.keys(BUILT_IN_PROFILE_DEFAULTS).forEach(function (k) {
      COMPANY_PROFILES[k] = Object.assign({}, BUILT_IN_PROFILE_DEFAULTS[k]);
    });

    var userProfiles = readStoredObject(CUSTOM_PROFILES_KEY);
    Object.keys(userProfiles).forEach(function (k) {
      var p = userProfiles[k];
      if (p && typeof p === "object") {
        COMPANY_PROFILES[k] = profileFromCompanyData(p, true);
      }
    });

    var overrides = readStoredObject(PROFILE_OVERRIDES_KEY);
    Object.keys(overrides).forEach(function (k) {
      if (COMPANY_PROFILES[k] && !COMPANY_PROFILES[k].userCreated && !isCustomProfile(k)) {
        Object.assign(COMPANY_PROFILES[k], overrides[k]);
      }
    });

    var assets = readStoredObject(PROFILE_ASSETS_KEY);
    Object.keys(assets).forEach(function (k) {
      if (COMPANY_PROFILES[k] && assets[k] && typeof assets[k] === "object") {
        if (assets[k].logo) COMPANY_PROFILES[k].logo = assets[k].logo;
        if (assets[k].stamp) COMPANY_PROFILES[k].stamp = assets[k].stamp;
      }
    });

    return COMPANY_PROFILES;
  }

  function persistUserProfiles() {
    if (typeof localStorage === "undefined") return;
    var stored = {};
    Object.keys(COMPANY_PROFILES).forEach(function (key) {
      if (COMPANY_PROFILES[key] && COMPANY_PROFILES[key].userCreated) {
        stored[key] = COMPANY_PROFILES[key];
      }
    });
    localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(stored));
  }

  function persistProfileAsset(profileKey, assetName, dataUrl) {
    if (typeof localStorage === "undefined") return;
    var overrides = readStoredObject(PROFILE_ASSETS_KEY);
    var entry = overrides[profileKey] && typeof overrides[profileKey] === "object" ? overrides[profileKey] : {};
    if (dataUrl) entry[assetName] = String(dataUrl);
    else delete entry[assetName];
    if (Object.keys(entry).length) overrides[profileKey] = entry;
    else delete overrides[profileKey];
    localStorage.setItem(PROFILE_ASSETS_KEY, JSON.stringify(overrides));
  }

  function persistProfileDetails(profileKey) {
    if (typeof localStorage === "undefined") return;
    var profile = COMPANY_PROFILES[profileKey];
    if (!profile || isCustomProfile(profileKey)) return;
    if (profile.userCreated) {
      persistUserProfiles();
      return;
    }
    var overrides = readStoredObject(PROFILE_OVERRIDES_KEY);
    overrides[profileKey] = {
      label: profile.label,
      name: profile.name,
      nationalId: profile.nationalId,
      address: profile.address,
      postalCode: profile.postalCode,
      phones: profile.phones,
      website: profile.website,
    };
    localStorage.setItem(PROFILE_OVERRIDES_KEY, JSON.stringify(overrides));
  }

  function hasBuiltInProfileOverride(profileKey) {
    if (!BUILT_IN_PROFILE_DEFAULTS[profileKey] || isCustomProfile(profileKey)) return false;
    return !!(readStoredObject(PROFILE_OVERRIDES_KEY)[profileKey] || readStoredObject(PROFILE_ASSETS_KEY)[profileKey]);
  }

  function restoreBuiltInProfileDefaults(profileKey) {
    var pristine = BUILT_IN_PROFILE_DEFAULTS[profileKey];
    if (!pristine || isCustomProfile(profileKey) || (COMPANY_PROFILES[profileKey] || {}).userCreated) return "ineligible";

    var keys = [PROFILE_OVERRIDES_KEY, PROFILE_ASSETS_KEY];
    var previous = [];
    var payloads = [];
    try {
      for (var i = 0; i < keys.length; i += 1) {
        var raw = localStorage.getItem(keys[i]);
        previous.push(raw);
        var parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("unreadable");
        delete parsed[profileKey];
        payloads.push(JSON.stringify(parsed));
      }
    } catch (err) {
      return "unreadable";
    }

    var written = 0;
    try {
      for (var w = 0; w < keys.length; w += 1) {
        localStorage.setItem(keys[w], payloads[w]);
        written += 1;
      }
    } catch (err) {
      while (written > 0) {
        written -= 1;
        try {
          if (previous[written] === null) localStorage.removeItem(keys[written]);
          else localStorage.setItem(keys[written], previous[written]);
        } catch (rollbackErr) {
          /* ignore */
        }
      }
      return "write";
    }

    COMPANY_PROFILES[profileKey] = Object.assign({}, pristine);
    return "";
  }

  function deleteUserProfile(profileKey) {
    var profile = COMPANY_PROFILES[profileKey];
    if (!profile || !profile.userCreated || isCustomProfile(profileKey) || BUILT_IN_PROFILE_DEFAULTS[profileKey]) {
      return "ineligible";
    }
    var previousRaw;
    try {
      previousRaw = localStorage.getItem(CUSTOM_PROFILES_KEY);
    } catch (err) {
      return "write";
    }
    delete COMPANY_PROFILES[profileKey];
    try {
      persistUserProfiles();
    } catch (err) {
      COMPANY_PROFILES[profileKey] = profile;
      try {
        if (previousRaw === null) localStorage.removeItem(CUSTOM_PROFILES_KEY);
        else localStorage.setItem(CUSTOM_PROFILES_KEY, previousRaw);
      } catch (rollbackErr) {
        /* ignore */
      }
      return "write";
    }
    return "";
  }

  function registerEmbeddedProfile(company) {
    if (!company || typeof company !== "object") return DEFAULT_PROFILE_KEY;
    var profileKey = String(company.profile || "").trim();
    if (COMPANY_PROFILES[profileKey]) return profileKey;

    var name = String(company.name || "").trim();
    if (!name) return CUSTOM_PROFILE_KEY;

    var matchingKey = Object.keys(COMPANY_PROFILES).find(function (k) {
      return COMPANY_PROFILES[k] && COMPANY_PROFILES[k].name === name;
    });
    if (matchingKey) return matchingKey;

    var newKey = "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    COMPANY_PROFILES[newKey] = profileFromCompanyData(company, true);
    persistUserProfiles();
    return newKey;
  }

  function resolveProfile(key) {
    return COMPANY_PROFILES[key] || COMPANY_PROFILES[DEFAULT_PROFILE_KEY];
  }

  function resizeImageFile(file, maxSide) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type.match(/^image\//)) {
        reject(new Error("File is not an image"));
        return;
      }
      if (file.type === "image/svg+xml") {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
        return;
      }
      var img = new Image();
      img.onload = function () {
        var w = img.width;
        var h = img.height;
        var scale = 1;
        if (w > maxSide || h > maxSide) {
          scale = maxSide / Math.max(w, h);
        }
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

if (typeof window !== "undefined") {
  window.CompanyRepository = {
    CUSTOM_PROFILES_KEY: CUSTOM_PROFILES_KEY,
    PROFILE_ASSETS_KEY: PROFILE_ASSETS_KEY,
    PROFILE_OVERRIDES_KEY: PROFILE_OVERRIDES_KEY,
    CUSTOM_PROFILE_KEY: CUSTOM_PROFILE_KEY,
    DEFAULT_PROFILE_KEY: DEFAULT_PROFILE_KEY,
    BUILT_IN_PROFILE_ORDER: BUILT_IN_PROFILE_ORDER,
    BUILT_IN_PROFILE_DEFAULTS: BUILT_IN_PROFILE_DEFAULTS,
    getProfiles: function () { return COMPANY_PROFILES; },
    isCustomProfile: isCustomProfile,
    profileFromCompanyData: profileFromCompanyData,
    hydrateCompanyProfiles: hydrateCompanyProfiles,
    persistUserProfiles: persistUserProfiles,
    persistProfileAsset: persistProfileAsset,
    persistProfileDetails: persistProfileDetails,
    hasBuiltInProfileOverride: hasBuiltInProfileOverride,
    restoreBuiltInProfileDefaults: restoreBuiltInProfileDefaults,
    deleteUserProfile: deleteUserProfile,
    registerEmbeddedProfile: registerEmbeddedProfile,
    resolveProfile: resolveProfile,
    resizeImageFile: resizeImageFile,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CUSTOM_PROFILES_KEY: CUSTOM_PROFILES_KEY,
    PROFILE_ASSETS_KEY: PROFILE_ASSETS_KEY,
    PROFILE_OVERRIDES_KEY: PROFILE_OVERRIDES_KEY,
    CUSTOM_PROFILE_KEY: CUSTOM_PROFILE_KEY,
    DEFAULT_PROFILE_KEY: DEFAULT_PROFILE_KEY,
    BUILT_IN_PROFILE_ORDER: BUILT_IN_PROFILE_ORDER,
    BUILT_IN_PROFILE_DEFAULTS: BUILT_IN_PROFILE_DEFAULTS,
    getProfiles: function () { return COMPANY_PROFILES; },
    isCustomProfile: isCustomProfile,
    profileFromCompanyData: profileFromCompanyData,
    hydrateCompanyProfiles: hydrateCompanyProfiles,
    persistUserProfiles: persistUserProfiles,
    persistProfileAsset: persistProfileAsset,
    persistProfileDetails: persistProfileDetails,
    hasBuiltInProfileOverride: hasBuiltInProfileOverride,
    restoreBuiltInProfileDefaults: restoreBuiltInProfileDefaults,
    deleteUserProfile: deleteUserProfile,
    registerEmbeddedProfile: registerEmbeddedProfile,
    resolveProfile: resolveProfile,
    resizeImageFile: resizeImageFile,
  };
}
