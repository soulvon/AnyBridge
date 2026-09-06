//! Implements Windows-specific certificate authority integration.
//! Native Windows system root-store access without external command-line tools.

use std::{ffi::c_void, io, ptr, slice};

use windows_sys::Win32::Security::Cryptography::{
    CertCloseStore, CertEnumCertificatesInStore, CertOpenStore, CERT_STORE_OPEN_EXISTING_FLAG,
    CERT_STORE_PROV_SYSTEM_W, CERT_STORE_READONLY_FLAG, CERT_SYSTEM_STORE_CURRENT_USER,
    CERT_SYSTEM_STORE_LOCAL_MACHINE,
};

use crate::{Error, Result};

const ROOT_STORE: [u16; 5] = [b'R' as u16, b'O' as u16, b'O' as u16, b'T' as u16, 0];

pub(super) fn is_installed(cert: &str) -> Result<bool> {
    let der = certificate_der(cert)?;
    Ok(store_contains(&der, CERT_SYSTEM_STORE_CURRENT_USER)?
        || store_contains(&der, CERT_SYSTEM_STORE_LOCAL_MACHINE)?)
}

fn store_contains(der: &[u8], system_store: u32) -> Result<bool> {
    let store = open_root_store(system_store)?;
    let mut context = ptr::null();
    let mut found = false;
    loop {
        context = unsafe { CertEnumCertificatesInStore(store, context) };
        if context.is_null() {
            break;
        }
        let encoded = unsafe {
            slice::from_raw_parts((*context).pbCertEncoded, (*context).cbCertEncoded as usize)
        };
        if encoded == der {
            found = true;
            break;
        }
    }
    if !context.is_null() {
        unsafe { windows_sys::Win32::Security::Cryptography::CertFreeCertificateContext(context) };
    }
    close_store(store)?;
    Ok(found)
}

fn certificate_der(cert: &str) -> Result<Vec<u8>> {
    pem::parse(cert)
        .map(|pem| pem.into_contents())
        .map_err(|error| Error::Config(format!("parse CA PEM: {error}")))
}

fn open_root_store(system_store: u32) -> Result<*mut c_void> {
    let flags = system_store | CERT_STORE_OPEN_EXISTING_FLAG | CERT_STORE_READONLY_FLAG;
    let store = unsafe {
        CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            0,
            0,
            flags,
            ROOT_STORE.as_ptr().cast(),
        )
    };
    if store.is_null() {
        return Err(Error::Config(format!(
            "open Windows LocalMachine Root store: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(store)
}

fn close_store(store: *mut c_void) -> Result<()> {
    if unsafe { CertCloseStore(store, 0) } == 0 {
        return Err(Error::Config(format!(
            "close Windows certificate store: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(())
}
