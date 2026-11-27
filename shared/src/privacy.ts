/** Cambiar versión al cambiar el contenido: las cuentas deben aceptar nuevamente. */
export const PRIVACY_NOTICE = {
  version: '2026-11-27.1',
  updatedAt: '2026-11-27',
  controller: 'ARCM Solutions',
  contact: 'jona16lozada@gmail.com',
  title: 'Aviso de privacidad y tratamiento de datos personales',
  sections: [
    { title: 'Responsable y contacto', text: 'ARCM Solutions administra Pliego. Para consultas sobre tus datos o para solicitar acceso, rectificación, eliminación o retirar tu autorización, escribe a jona16lozada@gmail.com desde el correo de tu cuenta. Verificaremos tu identidad y responderemos según la normativa aplicable.' },
    { title: 'Qué datos tratamos', text: 'Tratamos tu correo, nombre si lo proporcionas, identificador de Google si lo vinculas, contraseña protegida mediante hash cuando usas una cuenta local, sesiones, proyectos y archivos que guardas, resultados de compilación, roles, invitaciones y datos de presencia en colaboración. También registramos la versión y fecha de aceptación de este aviso y registros técnicos para operar y proteger el servicio.' },
    { title: 'Para qué los usamos', text: 'Usamos estos datos para identificarte, guardar y compilar tus documentos, sincronizar la edición, aplicar permisos, enviar invitaciones y mantener la seguridad del servicio. Este aviso cubre esas funciones; no solicita autorización para publicidad ni para usos ajenos a Pliego.' },
    { title: 'Google y correo electrónico', text: 'Si eliges Google, solicitamos únicamente identidad básica, correo y perfil. No solicitamos acceso a tus mensajes de Gmail ni a Google Drive. Google trata la autenticación bajo su propia política. Para enviar invitaciones utilizamos el proveedor SMTP configurado por ARCM Solutions, que procesa la dirección de destino y el contenido del mensaje, incluido el enlace. Una invitación solo puede aceptarla el correo invitado verificado con Google.' },
    { title: 'Colaboración y tus documentos', text: 'Los miembros autorizados de un proyecto pueden acceder a su contenido según su rol y ver datos de identidad necesarios para colaborar. El dueño administra miembros y permisos. Comparte solo contenido que tengas derecho a utilizar y evita incluir datos personales de terceros sin autorización. Los enlaces libres anteriores pueden conceder acceso a cualquier cuenta que los tenga hasta que el dueño los revoque.' },
    { title: 'Conservación y seguridad', text: 'Guardamos los datos mientras sean necesarios para prestar el servicio y atender solicitudes o responsabilidades aplicables. Las sesiones caducan, las invitaciones tienen vencimiento y los resultados de compilación tienen una retención técnica limitada. Las copias de respaldo y registros pueden tener ciclos de conservación distintos; consulta al responsable por los plazos de tu información. Aplicamos controles de acceso y protección técnica; ningún sistema elimina todo riesgo.' },
    { title: 'Tu decisión y tus solicitudes', text: 'Antes de usar tus proyectos puedes leer este aviso, aceptarlo de forma expresa o cerrar sesión sin aceptar. Para autenticarte ya se han procesado los datos necesarios de acceso; aceptar habilita las funciones de Pliego. Puedes retirar tu autorización o solicitar la eliminación escribiendo al contacto indicado. Esto puede impedir continuar usando el servicio y no elimina automáticamente copias compartidas por otros usuarios ni información cuya conservación sea exigible. Cerrar sesión por sí solo no elimina tu cuenta.' },
    { title: 'Cambios del aviso', text: 'Registramos la versión aceptada y la fecha del servidor. Si cambia la versión, te pediremos leer y aceptar el aviso actualizado antes de continuar. No se considera aceptación abrir una página, iniciar sesión con Google ni recibir una invitación.' },
  ],
} as const;

export function hasAcceptedPrivacy(user: { privacy: { version: string; acceptedAt: string } | null }): boolean {
  return user.privacy?.version === PRIVACY_NOTICE.version && Boolean(user.privacy.acceptedAt);
}
