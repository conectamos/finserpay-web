plugins {
    id("com.android.application")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.finserpay.clientes"
    compileSdk = 36

    val releaseStoreFile = providers.environmentVariable("FINSERPAY_RELEASE_STORE_FILE")
    val releaseStorePassword = providers.environmentVariable("FINSERPAY_RELEASE_STORE_PASSWORD")
    val releaseKeyAlias = providers.environmentVariable("FINSERPAY_RELEASE_KEY_ALIAS")
    val releaseKeyPassword = providers.environmentVariable("FINSERPAY_RELEASE_KEY_PASSWORD")
    val hasReleaseSigning = releaseStoreFile.isPresent
            && releaseStorePassword.isPresent
            && releaseKeyAlias.isPresent
            && releaseKeyPassword.isPresent

    defaultConfig {
        applicationId = "com.finserpay.clientes"
        minSdk = 23
        targetSdk = 36
        versionCode = 3
        versionName = "1.0.2"
    }

    signingConfigs {
        create("releaseUpload") {
            if (hasReleaseSigning) {
                storeFile = file(releaseStoreFile.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("releaseUpload")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.13.0"))
    implementation("com.google.firebase:firebase-messaging")
}
