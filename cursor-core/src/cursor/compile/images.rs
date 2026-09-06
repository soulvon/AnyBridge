//! Resolves and persists images and blobs referenced by Cursor inputs.
use crate::{
    cursor::{protocol::proto::agent::v1 as pb, services::blob_sync::BlobSynchronizer},
    model::ContentPart,
    store::BlobId,
    Error, Result,
};

pub async fn parts(
    message: &pb::UserMessage,
    text: String,
    blobs: &BlobSynchronizer,
) -> Result<Vec<ContentPart>> {
    let mut parts = vec![ContentPart::Text { text }];
    if let Some(context) = &message.selected_context {
        for image in &context.selected_images {
            parts.push(ContentPart::Image {
                mime_type: image_mime_type(image)?,
                data: image_data(image, blobs).await?,
            });
        }
    }
    Ok(parts)
}

fn image_mime_type(image: &pb::SelectedImage) -> Result<String> {
    let mime_type = image.mime_type.trim();
    if !mime_type.starts_with("image/") || mime_type.len() == "image/".len() {
        return Err(Error::Protocol(format!(
            "selected image has invalid MIME type: {}",
            image.mime_type
        )));
    }
    Ok(mime_type.into())
}

async fn image_data(image: &pb::SelectedImage, blobs: &BlobSynchronizer) -> Result<Vec<u8>> {
    use pb::selected_image::DataOrBlobId;

    let data = match image.data_or_blob_id.as_ref() {
        Some(DataOrBlobId::Data(data)) => data.clone(),
        Some(DataOrBlobId::BlobId(raw_id)) => {
            let id = BlobId::from_bytes(raw_id)?;
            blobs.get(&id).await?.ok_or_else(|| {
                Error::Protocol(format!(
                    "selected image Blob is missing: {}",
                    id.to_base64()
                ))
            })?
        }
        Some(DataOrBlobId::BlobIdWithData(value)) => {
            let id = BlobId::from_bytes(&value.blob_id)?;
            if value.data.is_empty() {
                blobs.get(&id).await?.ok_or_else(|| {
                    Error::Protocol(format!(
                        "selected image Blob is missing: {}",
                        id.to_base64()
                    ))
                })?
            } else {
                blobs.cache_received(&id, &value.data).await?;
                value.data.clone()
            }
        }
        None => {
            return Err(Error::Protocol(
                "selected image is missing data_or_blob_id".into(),
            ))
        }
    };
    if data.is_empty() {
        return Err(Error::Protocol("selected image data is empty".into()));
    }
    Ok(data)
}
