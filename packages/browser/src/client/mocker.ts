import { getType } from '@vitest/utils'
import { extname } from 'pathe'
import { rpc } from './rpc'
import { getBrowserState } from './utils'

const now = Date.now

interface SpyModule {
  spyOn: typeof import('vitest').vi['spyOn']
}

export class VitestBrowserClientMocker {
  private queue = new Set<Promise<void>>()
  private mocks: Record<string, any> = {}
  private factories: Record<string, () => any> = {}

  private spyModule!: SpyModule

  public setSpyModule(mod: SpyModule) {
    this.spyModule = mod
  }

  public async importActual(id: string, importer: string) {
    const resolved = await rpc().resolveId(id, importer)
    if (resolved == null)
      throw new Error(`[vitest] Cannot resolve ${id} imported from ${importer}`)
    const ext = extname(resolved.id)
    const base = getBrowserState().config.base || '/'
    const url = new URL(`/@id${base}${resolved.id}`, location.href)
    const query = `_vitest_original&ext.${ext}`
    const actualUrl = `${url.pathname}${
      url.search ? `${url.search}&${query}` : `?${query}`
    }${url.hash}`
    return getBrowserState().wrapModule(() => import(actualUrl))
  }

  public async importMock(rawId: string, importer: string) {
    await this.prepare()
    const { resolvedId, type, mockPath } = await rpc().resolveMock(rawId, importer)

    const factoryReturn = this.get(resolvedId)
    if (factoryReturn)
      return factoryReturn

    if (this.factories[resolvedId])
      return await this.resolve(resolvedId)

    const base = getBrowserState().config.base || '/'
    if (type === 'redirect') {
      const url = new URL(`/@id${base}${mockPath}`, location.href)
      return import(url.toString())
    }
    const url = new URL(`/@id${base}${resolvedId}`, location.href)
    const query = url.search ? `${url.search}&t=${now()}` : `?t=${now()}`
    const moduleObject = await import(`${url.pathname}${query}${url.hash}`)
    return this.mockObject(moduleObject)
  }

  public getMockContext() {
    return { callstack: null }
  }

  public get(id: string) {
    return this.mocks[id]
  }

  public async resolve(id: string) {
    const factory = this.factories[id]
    if (!factory)
      throw new Error(`Cannot resolve ${id} mock: no factory provided`)
    try {
      this.mocks[id] = await factory()
      return this.mocks[id]
    }
    catch (err) {
      const vitestError = new Error(
        '[vitest] There was an error when mocking a module. '
        + 'If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file. '
        + 'Read more: https://vitest.dev/api/vi.html#vi-mock',
      )
      vitestError.cause = err
      throw vitestError
    }
  }

  public queueMock(id: string, importer: string, factory?: () => any) {
    const promise = rpc().queueMock(id, importer, !!factory)
      .then((id) => {
        this.factories[id] = factory!
      }).finally(() => {
        this.queue.delete(promise)
      })
    this.queue.add(promise)
  }

  public queueUnmock(id: string, importer: string) {
    const promise = rpc().queueUnmock(id, importer)
      .then((id) => {
        delete this.factories[id]
      }).finally(() => {
        this.queue.delete(promise)
      })
    this.queue.add(promise)
  }

  public async prepare() {
    if (!this.queue.size)
      return
    await Promise.all([...this.queue.values()])
  }

  // TODO: move this logic into a util(?)
  public mockObject(object: Record<Key, any>, mockExports: Record<Key, any> = {}) {
    const finalizers = new Array<() => void>()
    const refs = new RefTracker()

    const define = (container: Record<Key, any>, key: Key, value: any) => {
      try {
        container[key] = value
        return true
      }
      catch {
        return false
      }
    }

    const mockPropertiesOf = (container: Record<Key, any>, newContainer: Record<Key, any>) => {
      const containerType = /* #__PURE__ */ getType(container)
      const isModule = containerType === 'Module' || !!container.__esModule
      for (const { key: property, descriptor } of getAllMockableProperties(container, isModule)) {
        // Modules define their exports as getters. We want to process those.
        if (!isModule && descriptor.get) {
          try {
            Object.defineProperty(newContainer, property, descriptor)
          }
          catch (error) {
            // Ignore errors, just move on to the next prop.
          }
          continue
        }

        // Skip special read-only props, we don't want to mess with those.
        if (isSpecialProp(property, containerType))
          continue

        const value = container[property]

        // Special handling of references we've seen before to prevent infinite
        // recursion in circular objects.
        const refId = refs.getId(value)
        if (refId !== undefined) {
          finalizers.push(() => define(newContainer, property, refs.getMockedValue(refId)))
          continue
        }

        const type = /* #__PURE__ */ getType(value)

        if (Array.isArray(value)) {
          define(newContainer, property, [])
          continue
        }

        const isFunction = type.includes('Function') && typeof value === 'function'
        if ((!isFunction || value.__isMockFunction) && type !== 'Object' && type !== 'Module') {
          define(newContainer, property, value)
          continue
        }

        // Sometimes this assignment fails for some unknown reason. If it does,
        // just move along.
        if (!define(newContainer, property, isFunction ? value : {}))
          continue

        if (isFunction) {
          const spyModule = this.spyModule
          if (!spyModule)
            throw new Error('[vitest] `spyModule` is not defined. This is Vitest error. Please open a new issue with reproduction.')
          function mockFunction(this: any) {
            // detect constructor call and mock each instance's methods
            // so that mock states between prototype/instances don't affect each other
            // (jest reference https://github.com/jestjs/jest/blob/2c3d2409879952157433de215ae0eee5188a4384/packages/jest-mock/src/index.ts#L678-L691)
            if (this instanceof newContainer[property]) {
              for (const { key, descriptor } of getAllMockableProperties(this, false)) {
                // skip getter since it's not mocked on prototype as well
                if (descriptor.get)
                  continue

                const value = this[key]
                const type = /* #__PURE__ */ getType(value)
                const isFunction = type.includes('Function') && typeof value === 'function'
                if (isFunction) {
                  // mock and delegate calls to original prototype method, which should be also mocked already
                  const original = this[key]
                  const mock = spyModule.spyOn(this, key as string).mockImplementation(original)
                  mock.mockRestore = () => {
                    mock.mockReset()
                    mock.mockImplementation(original)
                    return mock
                  }
                }
              }
            }
          }
          const mock = spyModule.spyOn(newContainer, property).mockImplementation(mockFunction)
          mock.mockRestore = () => {
            mock.mockReset()
            mock.mockImplementation(mockFunction)
            return mock
          }
          // tinyspy retains length, but jest doesn't.
          Object.defineProperty(newContainer[property], 'length', { value: 0 })
        }

        refs.track(value, newContainer[property])
        mockPropertiesOf(value, newContainer[property])
      }
    }

    const mockedObject: Record<Key, any> = mockExports
    mockPropertiesOf(object, mockedObject)

    // Plug together refs
    for (const finalizer of finalizers)
      finalizer()

    return mockedObject
  }
}

function isSpecialProp(prop: Key, parentType: string) {
  return parentType.includes('Function')
    && typeof prop === 'string'
    && ['arguments', 'callee', 'caller', 'length', 'name'].includes(prop)
}

class RefTracker {
  private idMap = new Map<any, number>()
  private mockedValueMap = new Map<number, any>()

  public getId(value: any) {
    return this.idMap.get(value)
  }

  public getMockedValue(id: number) {
    return this.mockedValueMap.get(id)
  }

  public track(originalValue: any, mockedValue: any): number {
    const newId = this.idMap.size
    this.idMap.set(originalValue, newId)
    this.mockedValueMap.set(newId, mockedValue)
    return newId
  }
}

type Key = string | symbol

export function getAllMockableProperties(obj: any, isModule: boolean) {
  const allProps = new Map<string | symbol, { key: string | symbol; descriptor: PropertyDescriptor }>()
  let curr = obj
  do {
    // we don't need properties from these
    if (curr === Object.prototype || curr === Function.prototype || curr === RegExp.prototype)
      break

    collectOwnProperties(curr, (key) => {
      const descriptor = Object.getOwnPropertyDescriptor(curr, key)
      if (descriptor)
        allProps.set(key, { key, descriptor })
    })
  // eslint-disable-next-line no-cond-assign
  } while (curr = Object.getPrototypeOf(curr))
  // default is not specified in ownKeys, if module is interoped
  if (isModule && !allProps.has('default') && 'default' in obj) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, 'default')
    if (descriptor)
      allProps.set('default', { key: 'default', descriptor })
  }
  return Array.from(allProps.values())
}

function collectOwnProperties(obj: any, collector: Set<string | symbol> | ((key: string | symbol) => void)) {
  const collect = typeof collector === 'function' ? collector : (key: string | symbol) => collector.add(key)
  Object.getOwnPropertyNames(obj).forEach(collect)
  Object.getOwnPropertySymbols(obj).forEach(collect)
}
