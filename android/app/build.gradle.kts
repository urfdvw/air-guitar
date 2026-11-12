plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.urfdvw.airguitar"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.urfdvw.airguitar"
        minSdk = 26
        targetSdk = 35
        // CI stamps the run number and commit, so a log says which build made it.
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.0-" + (System.getenv("GITHUB_SHA")?.take(7) ?: "local")
    }

    signingConfigs {
        // A committed debug key, so every CI build installs over the last one
        // instead of failing on a signature mismatch. It signs debug builds only.
        getByName("debug") {
            storeFile = rootProject.file("keystore/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}

// The web app at the repository root is the single source of the UI. Copy it
// into the APK's assets on every build rather than keeping a second copy.
val copyWebApp by tasks.registering(Sync::class) {
    val webRoot = rootProject.projectDir.parentFile
    from(webRoot) {
        include("index.html", "manifest.json", "css/**", "js/**", "icons/**")
    }
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild") {
    dependsOn(copyWebApp)
}
