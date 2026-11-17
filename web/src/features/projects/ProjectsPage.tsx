// Mis proyectos: lista con buscador, rol y última modificación; crear, importar, descargar, renombrar
// y borrar (estas dos, solo el dueño). Paso 1: datos de ejemplo.
// `?estado=vacia|cargando|error` muestra esos estados; `?importar=invalido|muchos|grande`, el error de importar.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ProjectSummary } from '@latexweb/shared';
import { AccountMenu } from '../../components/AccountMenu';
import { Button, IconButton } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Logo } from '../../components/Logo';
import { Menu } from '../../components/Menu';
import { RoleBadge } from '../../components/RoleBadge';
import { relativeTime } from '../../lib/format';
import { PROJECTS } from '../../lib/mock';
import { ImportZipDialog, NewProjectDialog, RenameProjectDialog } from './ProjectDialogs';

const COLUMNS = 'md:grid-cols-[minmax(0,1fr)_150px_190px_96px]';

export function ProjectsPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const state = params.get('estado');
  const importError = params.get('importar');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'nuevo' | 'importar' | null>(importError ? 'importar' : null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);

  const projects = state === 'vacia' ? [] : PROJECTS;
  const filtered = projects.filter((p) => p.name.toLocaleLowerCase('es').includes(query.trim().toLocaleLowerCase('es')));
  const loaded = state !== 'cargando' && state !== 'error';

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-4 px-5 sm:px-8">
          <Link to="/" className="text-text no-underline">
            <Logo />
          </Link>
          <AccountMenu />
        </div>
      </header>

      <main className="mx-auto flex max-w-[1120px] flex-col gap-7 px-5 py-8 sm:px-8 sm:py-12">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 font-serif text-[34px] leading-none font-medium tracking-tight sm:text-[44px]">Mis proyectos</h1>
            {loaded && projects.length > 0 && (
              <p className="m-0 text-sm text-muted">{projects.length} proyectos, del más reciente al más antiguo</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Button icon="zip" onClick={() => setDialog('importar')}>
              Importar zip
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setDialog('nuevo')}>
              Nuevo proyecto
            </Button>
          </div>
        </div>

        {state === 'cargando' && <ListSkeleton />}
        {state === 'error' && <ListError />}
        {loaded && projects.length === 0 && <FirstTime onNew={() => setDialog('nuevo')} onImport={() => setDialog('importar')} />}

        {loaded && projects.length > 0 && (
          <div className="flex flex-col gap-4">
            <div className="relative max-w-[440px]">
              <Icon name="search" className="pointer-events-none absolute top-[13px] left-[13px] text-muted" />
              <input
                type="search"
                aria-label="Buscar proyectos por nombre"
                placeholder="Buscar por nombre"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 w-full rounded-md border-[1.5px] border-border-input bg-surface pr-3 pl-10 text-[15px] text-text placeholder:text-muted"
              />
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-6">
                <p className="m-0 text-[15px]">Ningún proyecto coincide con “{query.trim()}”.</p>
                <Button size="sm" onClick={() => setQuery('')}>
                  Limpiar la búsqueda
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-surface">
                <div className={`hidden h-10 items-center gap-4 border-b border-border px-5 text-[13px] font-semibold text-muted md:grid ${COLUMNS}`}>
                  <span>Nombre</span>
                  <span>Mi rol</span>
                  <span>Última modificación</span>
                  <span className="text-right">Acciones</span>
                </div>
                <ul className="m-0 list-none p-0">
                  {filtered.map((project, index) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      first={index === 0}
                      onRename={() => setRenaming(project)}
                      onDelete={() => setDeleting(project)}
                    />
                  ))}
                </ul>
              </div>
            )}
            <p className="m-0 text-[13px] text-muted">Renombrar y borrar aparecen solo en los proyectos donde sos dueño.</p>
          </div>
        )}
      </main>

      <NewProjectDialog open={dialog === 'nuevo'} onClose={() => setDialog(null)} onCreate={() => navigate('/proyectos/erosion')} />
      <ImportZipDialog
        open={dialog === 'importar'}
        onClose={() => setDialog(null)}
        demoError={importError === 'invalido' || importError === 'muchos' || importError === 'grande' ? importError : null}
      />
      {renaming && <RenameProjectDialog key={renaming.id} name={renaming.name} open onClose={() => setRenaming(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => setDeleting(null)}
        title="¿Borrar el proyecto?"
        confirmLabel="Borrar proyecto"
        confirmText={deleting?.name}
      >
        Se borran todos sus archivos y compilaciones, también para los demás miembros. No se puede deshacer.
      </ConfirmDialog>
    </div>
  );
}

interface ProjectRowProps {
  project: ProjectSummary;
  first: boolean;
  onRename: () => void;
  onDelete: () => void;
}

function ProjectRow({ project, first, onRename, onDelete }: ProjectRowProps) {
  const owner = project.role === 'owner';
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-bg md:min-h-16 md:px-5 md:py-2.5 ${COLUMNS} ${
        first ? '' : 'border-t border-border'
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <Icon name="tex" />
        </span>
        <Link to={`/proyectos/${project.id}`} title={project.name} className="min-w-0 truncate text-[15px] font-semibold text-text no-underline hover:underline">
          {project.name}
        </Link>
      </div>
      <div className="col-start-1 row-start-2 flex items-center gap-3 pl-12 md:contents">
        <RoleBadge role={project.role} />
        <time dateTime={project.updatedAt} className="text-sm whitespace-nowrap text-muted">
          {relativeTime(project.updatedAt)}
        </time>
      </div>
      <div className="col-start-2 row-span-2 row-start-1 flex justify-end gap-1 md:col-start-auto md:row-span-1 md:row-start-auto">
        <IconButton icon="download" label={`Descargar ${project.name} como zip`} />
        {owner ? (
          <Menu
            items={[
              { label: 'Renombrar', icon: 'pencil', onSelect: onRename },
              { label: 'Descargar como zip', icon: 'download' },
              { label: 'Borrar proyecto…', icon: 'trash', danger: true, separated: true, onSelect: onDelete },
            ]}
            trigger={(props) => <IconButton icon="more" label={`Más acciones para ${project.name}`} {...props} />}
          />
        ) : (
          <span className="size-10" />
        )}
      </div>
    </li>
  );
}

function FirstTime({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <section className="flex flex-col items-center gap-7 px-0 py-6 text-center sm:py-12">
      <div aria-hidden="true" className="relative h-[150px] w-40">
        <div className="absolute top-2.5 left-[34px] h-[134px] w-[104px] rotate-6 rounded bg-surface-2" />
        <div className="absolute top-1 left-[22px] flex h-[134px] w-[104px] flex-col gap-2 rounded bg-white px-4 py-[26px] shadow-pop">
          <span className="flex items-center gap-0.5">
            <span className="h-[7px] w-[46px] rounded-sm bg-[#e3e0d8]" />
            <span className="h-3.5 w-0.5 animate-blink bg-accent" />
          </span>
          <span className="h-[5px] w-[70px] rounded-sm bg-[#eceae4]" />
          <span className="h-[5px] w-[62px] rounded-sm bg-[#eceae4]" />
          <span className="h-[5px] w-[66px] rounded-sm bg-[#eceae4]" />
        </div>
      </div>
      <div className="flex max-w-[520px] flex-col gap-2.5">
        <h2 className="m-0 font-serif text-[32px] leading-tight font-normal tracking-tight sm:text-[40px]">
          Tu primer documento empieza <i>acá</i>
        </h2>
        <p className="m-0 text-base leading-relaxed text-pretty text-muted">
          Creá un proyecto nuevo y escribí desde una plantilla, o importá un .zip con un proyecto que ya tengas.
        </p>
      </div>
      <div className="grid w-full max-w-[640px] grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4 text-left">
        <button type="button" onClick={onNew} className="flex flex-col gap-3 rounded-xl border-[1.5px] border-border bg-surface p-[22px] text-left text-text shadow-sm hover:border-border-input">
          <span className="flex size-10 items-center justify-center rounded-[10px] bg-accent text-on-accent">
            <Icon name="filePlus" size={20} />
          </span>
          <span className="text-[17px] font-semibold">Nuevo proyecto</span>
          <span className="text-sm leading-normal text-muted">Arranca con un main.tex de plantilla, listo para escribir. Solo te pedimos el nombre.</span>
        </button>
        <button type="button" onClick={onImport} className="flex flex-col gap-3 rounded-xl border-[1.5px] border-dashed border-border-input p-[22px] text-left text-text hover:bg-surface">
          <span className="flex size-10 items-center justify-center rounded-[10px] bg-surface-2">
            <Icon name="upload" size={20} />
          </span>
          <span className="text-[17px] font-semibold">Importar zip</span>
          <span className="text-sm leading-normal text-muted">Arrastralo hasta acá o tocá para elegirlo. Hasta 500 archivos y 200 MB.</span>
        </button>
      </div>
      <p className="m-0 max-w-[520px] text-sm text-muted">
        ¿Nunca usaste LaTeX? La plantilla trae lo básico. Escribís a la izquierda, tocás Compilar y el PDF aparece a la derecha.
      </p>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface" aria-busy="true" aria-label="Cargando proyectos">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className={`flex h-16 items-center gap-3 px-5 ${index ? 'border-t border-border' : ''}`}>
          <span className="size-9 animate-pulse rounded-lg bg-surface-2" />
          <span className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${40 - index * 4}%` }} />
          <span className="ml-auto hidden h-3 w-24 animate-pulse rounded bg-surface-2 md:block" />
        </div>
      ))}
    </div>
  );
}

function ListError() {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-6">
      <span className="flex items-center gap-2 text-[15px] font-semibold text-error">
        <Icon name="error" /> No pudimos cargar tus proyectos
      </span>
      <p className="m-0 text-sm text-muted">Puede ser la conexión o un problema nuestro. Tus proyectos están a salvo.</p>
      <Button size="sm" icon="sync">
        Reintentar
      </Button>
    </div>
  );
}
