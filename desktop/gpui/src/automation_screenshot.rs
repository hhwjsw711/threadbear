// Encoding the scripted window's pixels, away from the app's thread.
use image::{codecs::png::{CompressionType, FilterType, PngEncoder}, ImageEncoder, ImageFormat, RgbaImage};
use std::io::{BufWriter, Write};
use std::path::Path;

pub(crate) fn save(image: &RgbaImage, path: &Path) -> Result<(), String> {
    let save = || -> Result<(), Box<dyn std::error::Error>> {
        let format = ImageFormat::from_path(path)?;
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let mut pending = tempfile::NamedTempFile::new_in(parent)?;
        {
            let mut writer = BufWriter::new(pending.as_file_mut());
            if format == ImageFormat::Png {
                // Adaptive filtering tries every filter for every row. In a
                // debug app at background priority this took 30 seconds for
                // one window (14 Nov), longer than the caller's timeout.
                // Sub keeps all pixels and compresses UI's flat areas well.
                PngEncoder::new_with_quality(&mut writer, CompressionType::Fast, FilterType::Sub)
                    .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)?;
            } else {
                image.write_to(&mut writer, format)?;
            }
            writer.flush()?;
        }
        // Publish only the finished image. An error leaves an older shot
        // alone and still returns an error to this request's caller.
        pending.persist(path)?;
        Ok(())
    };
    save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels() -> RgbaImage {
        RgbaImage::from_fn(127, 83, |x, y| image::Rgba([x as u8, y as u8, (x * y) as u8, (x + y) as u8]))
    }

    #[test]
    fn a_completed_png_has_every_pixel_including_alpha() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.png");
        let image = pixels();
        save(&image, &path).unwrap();
        assert_eq!(image::open(path).unwrap().to_rgba8(), image);
    }

    #[test]
    fn an_old_screenshot_is_replaced_only_by_a_completed_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.png");
        std::fs::write(&path, b"old image").unwrap();
        save(&pixels(), &path).unwrap();
        assert_eq!(image::open(path).unwrap().to_rgba8(), pixels());
        // JPEG cannot encode RGBA. A late encoder error must return an
        // error and leave the old file alone, never make it look like a shot.
        let path = dir.path().join("window.jpg");
        std::fs::write(&path, b"old image").unwrap();
        assert!(save(&pixels(), &path).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"old image");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn a_missing_parent_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save(&pixels(), &dir.path().join("missing/window.png")).is_err());
    }

    #[test]
    fn a_publish_error_cleans_up_the_pending_image() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window.png");
        std::fs::create_dir(&path).unwrap();
        assert!(save(&pixels(), &path).is_err());
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
